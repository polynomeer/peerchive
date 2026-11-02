/**
 * GitHub 웹훅 수신(E-11, ADR 0056). `POST /api/github/webhook`(세션·CSRF와 무관, 서명만 봄).
 *
 * 순서
 * 1. 기능이 꺼져 있으면 404. 본문 상한 1MB(선언 길이·실제 길이 모두, 서명 확인 전에) → 413.
 * 2. `X-Hub-Signature-256`을 받은 **원문 바이트**로 확인(상수 시간). 없거나 틀리면 401(이유를 구분하지 않음).
 * 3. `X-GitHub-Delivery`(GUID) 형식 확인. 이미 처리한 전달 id면 409 `replayed`(7일 기억). 전달 id는 처리와 **같은 트랜잭션**에 넣어
 *    처리에 실패한 전달은 GitHub 재전달로 다시 받을 수 있습니다. 전달 id는 서명 밖의 헤더라 다른 id로 다시 보내는 재전송도 막기 위해
 *    수집은 멱등(커밋 SHA·PR 번호 unique, PR은 더 새 `updated_at`만 반영)이고, 연결을 끊는 이벤트는 GitHub API로 지금 상태를 다시 확인합니다.
 * 4. 연결되지 않은 저장소(또는 설치 id가 다른 저장소)의 이벤트는 저장하지 않고 200 `ignored`.
 *
 * 처리하는 이벤트(그 밖은 200 `ignored`)
 * - push: distinct 커밋마다 SHA·메시지 첫 줄(200자)·주소·시각·작성자. 작성자는 커밋 author의 GitHub username이 보낸 사람(sender)이면 그 번호,
 *   아니면 GitHub 계정을 연결한 회원의 로그인 이름으로 찾습니다. 맞출 수 없는 커밋은 저장하지 않습니다(메일 주소는 보지 않음). push당 100개까지.
 * - pull_request: opened·reopened·edited·closed(merged 구분) → 번호·제목·주소·작성자 번호·상태.
 * - installation: deleted·suspend → 그 설치의 연결 해제(API로 설치가 정말 없거나 정지인지 확인). installation_repositories: removed → 그 저장소 연결 해제(확인).
 * - repository: privatized·publicized → 연결의 비공개 여부 갱신, deleted → 연결 해제(확인).
 * - github_app_authorization: revoked → 그 GitHub 사용자의 회원 연결(integrations) 삭제.
 */
import { and, eq, githubItems, githubRepoLinks, githubWebhookDeliveries, inArray, integrations, isNull, lt, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { verifyWebhookSignature } from './app-auth'
import type { GithubClient } from './client'
import { detachLinks, forgetUnusedInstallations, type UnlinkReason } from './connect'

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
export const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_COMMITS_PER_PUSH = 100
export const TITLE_MAX = 200

export type WebhookStatus = 'processed' | 'ignored'

export class WebhookRejected extends Error {
  constructor(
    readonly status: 401 | 404 | 409 | 413 | 422,
    readonly code: 'invalid_signature' | 'not_found' | 'replayed' | 'too_large' | 'invalid_payload',
  ) {
    super(code)
    this.name = 'WebhookRejected'
  }
}

export interface WebhookRequest {
  event: string | null | undefined
  deliveryId: string | null | undefined
  signature: string | null | undefined
  body: Buffer
}

// ── 이벤트 해석(순수 함수) ────────────────────────────────────────────────

export interface CommitRecord {
  sha: string
  title: string
  url: string
  occurredAt: Date
  authorLogin: string | null
}

export type ParsedEvent =
  | { kind: 'push'; installationId: number | null; repoId: number; sender: { id: number; login: string } | null; commits: CommitRecord[] }
  | {
      kind: 'pull_request'
      installationId: number | null
      repoId: number
      number: number
      title: string
      url: string
      authorId: number
      state: 'open' | 'closed' | 'merged'
      createdAt: Date
      updatedAt: Date
    }
  | { kind: 'installation_removed'; installationId: number }
  | { kind: 'repos_removed'; installationId: number; repoIds: number[] }
  | { kind: 'repo_visibility'; installationId: number | null; repoId: number; private: boolean }
  | { kind: 'authorization_revoked'; githubUserId: number }
  | { kind: 'ignored' }

type Json = Record<string, unknown>
const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null)
const posInt = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null)
const date = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : null
}
const githubUrl = (value: unknown): string | null =>
  typeof value === 'string' && value.startsWith('https://github.com/') && value.length <= 500 && !/\s/.test(value) ? value : null
const login = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value) ? value : null)

/** 메시지·제목의 첫 줄(앞뒤 공백 제거, 200자에서 자름). 비면 null. */
export function firstLine(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const line = (value.split(/\r?\n/, 1)[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!line) return null
  const chars = [...line]
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : line
}

const installationOf = (body: Json) => posInt(obj(body.installation)?.id)
const repoIdOf = (body: Json) => posInt(obj(body.repository)?.id)

export function parseWebhookEvent(event: string, body: Json): ParsedEvent {
  const action = typeof body.action === 'string' ? body.action : null
  switch (event) {
    case 'push': {
      const repoId = repoIdOf(body)
      if (!repoId || body.deleted === true || !Array.isArray(body.commits)) return { kind: 'ignored' }
      const senderObj = obj(body.sender)
      const senderId = posInt(senderObj?.id)
      const senderLogin = login(senderObj?.login)
      const commits: CommitRecord[] = []
      for (const raw of body.commits) {
        const commit = obj(raw)
        if (!commit || commit.distinct === false) continue
        const sha = typeof commit.id === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit.id) ? commit.id : null
        const title = firstLine(commit.message)
        const url = githubUrl(commit.url)
        const occurredAt = date(commit.timestamp)
        if (!sha || !title || !url || !occurredAt) continue
        commits.push({ sha, title, url, occurredAt, authorLogin: login(obj(commit.author)?.username) })
        if (commits.length >= MAX_COMMITS_PER_PUSH) break
      }
      return {
        kind: 'push',
        installationId: installationOf(body),
        repoId,
        sender: senderId && senderLogin ? { id: senderId, login: senderLogin } : null,
        commits,
      }
    }
    case 'pull_request': {
      if (!action || !['opened', 'reopened', 'edited', 'closed'].includes(action)) return { kind: 'ignored' }
      const repoId = repoIdOf(body)
      const pr = obj(body.pull_request)
      const number = posInt(pr?.number)
      const title = firstLine(pr?.title)
      const url = githubUrl(pr?.html_url)
      const authorId = posInt(obj(pr?.user)?.id)
      const createdAt = date(pr?.created_at)
      const updatedAt = date(pr?.updated_at) ?? createdAt
      if (!repoId || !pr || !number || !title || !url || !authorId || !createdAt || !updatedAt) return { kind: 'ignored' }
      const state = pr.merged === true || (typeof pr.merged_at === 'string' && pr.merged_at) ? 'merged' : pr.state === 'closed' ? 'closed' : 'open'
      return { kind: 'pull_request', installationId: installationOf(body), repoId, number, title, url, authorId, state, createdAt, updatedAt }
    }
    case 'installation': {
      const installationId = installationOf(body)
      if (installationId && (action === 'deleted' || action === 'suspend')) return { kind: 'installation_removed', installationId }
      return { kind: 'ignored' }
    }
    case 'installation_repositories': {
      const installationId = installationOf(body)
      if (!installationId || action !== 'removed' || !Array.isArray(body.repositories_removed)) return { kind: 'ignored' }
      const repoIds = body.repositories_removed.map((r) => posInt(obj(r)?.id)).filter((id): id is number => id !== null)
      return repoIds.length ? { kind: 'repos_removed', installationId, repoIds } : { kind: 'ignored' }
    }
    case 'repository': {
      const repoId = repoIdOf(body)
      if (!repoId) return { kind: 'ignored' }
      if (action === 'privatized' || action === 'publicized') {
        return { kind: 'repo_visibility', installationId: installationOf(body), repoId, private: action === 'privatized' }
      }
      const installationId = installationOf(body)
      if (action === 'deleted' && installationId) return { kind: 'repos_removed', installationId, repoIds: [repoId] }
      return { kind: 'ignored' }
    }
    case 'github_app_authorization': {
      const userId = posInt(obj(body.sender)?.id)
      return action === 'revoked' && userId ? { kind: 'authorization_revoked', githubUserId: userId } : { kind: 'ignored' }
    }
    default:
      return { kind: 'ignored' }
  }
}

// ── 처리 ─────────────────────────────────────────────────────────────────

const DELIVERY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 연결 중인 저장소(설치 id까지 같을 때만). */
async function linkFor(db: DbExecutor, repoId: number, installationId: number | null) {
  const [row] = await db
    .select()
    .from(githubRepoLinks)
    .where(and(eq(githubRepoLinks.repoId, repoId), isNull(githubRepoLinks.unlinkedAt)))
    .limit(1)
  if (!row || (installationId !== null && row.installationId !== installationId)) return null
  return row
}

/** 커밋 작성자 username → GitHub 사용자 번호(보낸 사람이거나 계정을 연결한 회원일 때만). */
async function resolveAuthors(db: DbExecutor, commits: readonly CommitRecord[], sender: { id: number; login: string } | null): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (sender) result.set(sender.login.toLowerCase(), sender.id)
  const wanted = [...new Set(commits.map((c) => c.authorLogin?.toLowerCase()).filter((l): l is string => !!l && !result.has(l)))]
  if (wanted.length) {
    const rows = await db
      .select({ externalId: integrations.externalId, login: integrations.externalLogin })
      .from(integrations)
      .where(and(eq(integrations.provider, 'github'), isNull(integrations.revokedAt), inArray(sql`lower(${integrations.externalLogin})`, wanted)))
    for (const row of rows) if (row.login) result.set(row.login.toLowerCase(), Number(row.externalId))
  }
  return result
}

/**
 * 서명·전달 id를 확인한 웹훅 하나를 처리합니다. 거부는 WebhookRejected(경로 처리기가 상태 코드로 바꿈).
 * `client`는 연결을 끊는 이벤트를 GitHub API로 다시 확인할 때만 씁니다(네트워크는 DB 트랜잭션 밖에서).
 */
export async function receiveWebhook(
  db: DbExecutor,
  deps: { secret: string | null; client: GithubClient },
  request: WebhookRequest,
  now = new Date(),
): Promise<{ status: WebhookStatus }> {
  if (!deps.secret) throw new WebhookRejected(404, 'not_found')
  if (request.body.length > MAX_WEBHOOK_BODY_BYTES) throw new WebhookRejected(413, 'too_large')
  if (!verifyWebhookSignature(deps.secret, request.body, request.signature)) throw new WebhookRejected(401, 'invalid_signature')
  const deliveryId = typeof request.deliveryId === 'string' && DELIVERY_PATTERN.test(request.deliveryId) ? request.deliveryId.toLowerCase() : null
  const event = typeof request.event === 'string' && /^[a-z_]{1,50}$/.test(request.event) ? request.event : null
  if (!deliveryId || !event) throw new WebhookRejected(422, 'invalid_payload')
  let body: Json | null
  try {
    body = obj(JSON.parse(request.body.toString('utf8')))
  } catch {
    body = null
  }
  if (!body) throw new WebhookRejected(422, 'invalid_payload')

  const parsed = parseWebhookEvent(event, body)

  // 연결을 끊는 이벤트는 지금 상태를 GitHub에 다시 확인합니다(서명된 예전 본문을 다시 보내도 살아 있는 연결이 끊기지 않게).
  let confirmedRemoval: number[] | null = null
  if (parsed.kind === 'installation_removed') {
    const installation = await deps.client.getInstallation(parsed.installationId)
    confirmedRemoval = installation === null || installation.suspended ? [] : null
  } else if (parsed.kind === 'repos_removed') {
    const repos = await deps.client.listInstallationRepos(parsed.installationId)
    const still = new Set((repos ?? []).map((r) => r.id))
    confirmedRemoval = parsed.repoIds.filter((id) => !still.has(id))
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.delete(githubWebhookDeliveries).where(lt(githubWebhookDeliveries.receivedAt, new Date(now.getTime() - DELIVERY_TTL_MS)))
    const claimed = await tx
      .insert(githubWebhookDeliveries)
      .values({ deliveryId, receivedAt: now })
      .onConflictDoNothing()
      .returning({ id: githubWebhookDeliveries.deliveryId })
    if (claimed.length !== 1) throw new WebhookRejected(409, 'replayed')
    return applyEvent(tx, parsed, confirmedRemoval, now)
  })
  if (outcome.freedInstallations.length) await forgetUnusedInstallations(db, deps.client, outcome.freedInstallations)
  return { status: outcome.status }
}

async function applyEvent(
  tx: DbExecutor,
  parsed: ParsedEvent,
  confirmedRemoval: number[] | null,
  now: Date,
): Promise<{ status: WebhookStatus; freedInstallations: number[] }> {
  const ignored = { status: 'ignored' as const, freedInstallations: [] }
  switch (parsed.kind) {
    case 'push': {
      const link = await linkFor(tx, parsed.repoId, parsed.installationId)
      if (!link || parsed.commits.length === 0) return ignored
      const authors = await resolveAuthors(tx, parsed.commits, parsed.sender)
      const rows = parsed.commits.flatMap((commit) => {
        const authorGithubId = commit.authorLogin ? authors.get(commit.authorLogin.toLowerCase()) : undefined
        if (!authorGithubId) return []
        return [
          {
            linkId: link.id,
            projectId: link.projectId,
            kind: 'commit' as const,
            sha: commit.sha,
            title: commit.title,
            url: commit.url,
            authorGithubId,
            occurredAt: commit.occurredAt,
            createdAt: now,
            updatedAt: now,
          },
        ]
      })
      if (rows.length === 0) return ignored
      await tx.insert(githubItems).values(rows).onConflictDoNothing()
      return { status: 'processed', freedInstallations: [] }
    }
    case 'pull_request': {
      const link = await linkFor(tx, parsed.repoId, parsed.installationId)
      if (!link) return ignored
      await tx
        .insert(githubItems)
        .values({
          linkId: link.id,
          projectId: link.projectId,
          kind: 'pull_request',
          number: parsed.number,
          title: parsed.title,
          url: parsed.url,
          authorGithubId: parsed.authorId,
          prState: parsed.state,
          occurredAt: parsed.createdAt,
          sourceUpdatedAt: parsed.updatedAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [githubItems.linkId, githubItems.number],
          set: { title: parsed.title, url: parsed.url, prState: parsed.state, sourceUpdatedAt: parsed.updatedAt, updatedAt: now },
          // 늦게 도착한 이전 이벤트가 더 새 상태를 덮지 않게 합니다.
          setWhere: sql`${githubItems.sourceUpdatedAt} is null or ${githubItems.sourceUpdatedAt} <= ${parsed.updatedAt.toISOString()}::timestamptz`,
        })
      return { status: 'processed', freedInstallations: [] }
    }
    case 'repo_visibility': {
      const link = await linkFor(tx, parsed.repoId, parsed.installationId)
      if (!link) return ignored
      await tx.update(githubRepoLinks).set({ isPrivate: parsed.private }).where(eq(githubRepoLinks.id, link.id))
      return { status: 'processed', freedInstallations: [] }
    }
    case 'installation_removed':
    case 'repos_removed': {
      if (!confirmedRemoval) return ignored
      const conditions = [eq(githubRepoLinks.installationId, parsed.installationId), isNull(githubRepoLinks.unlinkedAt)]
      if (parsed.kind === 'repos_removed') {
        if (confirmedRemoval.length === 0) return ignored
        conditions.push(inArray(githubRepoLinks.repoId, confirmedRemoval))
      }
      const links = await tx.select({ id: githubRepoLinks.id, projectId: githubRepoLinks.projectId }).from(githubRepoLinks).where(and(...conditions))
      if (links.length === 0) return ignored
      const reason: UnlinkReason = parsed.kind === 'installation_removed' ? 'uninstalled' : 'repo_removed'
      const freed = await detachLinks(tx, links.map((l) => l.id), reason, now)
      for (const link of links) {
        await recordAudit(tx, {
          actorId: null,
          action: 'github.repo_unlink',
          targetType: 'github_repo_link',
          targetId: link.id,
          projectId: link.projectId,
          metadata: { reason },
        })
      }
      return { status: 'processed', freedInstallations: freed }
    }
    case 'authorization_revoked': {
      const removed = await tx
        .delete(integrations)
        .where(and(eq(integrations.provider, 'github'), eq(integrations.externalId, String(parsed.githubUserId))))
        .returning({ id: integrations.id, userId: integrations.userId })
      for (const row of removed) {
        await recordAudit(tx, {
          actorId: null,
          action: 'github.identity_unlink',
          targetType: 'integration',
          targetId: row.id,
          metadata: { reason: 'revoked' },
        })
      }
      return { status: removed.length ? 'processed' : 'ignored', freedInstallations: [] }
    }
    default:
      return ignored
  }
}
