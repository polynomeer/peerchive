/**
 * GitHub 계정 연결·저장소 연결 흐름(E-11, ADR 0056).
 *
 * 회원 계정 연결(identity)
 * 1. `POST /me/integrations/github/link` → state(identity) + GitHub 사용자 인증 주소.
 * 2. GitHub → `GET /github/oauth/callback?code&state` → state 확인(같은 로그인 사용자·10분·한 번만) → code를 사용자 토큰으로 바꿔
 *    `GET /user`로 GitHub 사용자 번호·로그인 이름만 읽고 → **토큰은 바로 폐기**(저장하지 않음) → integrations(provider github) 한 행.
 *    한 GitHub 계정은 한 회원에만(다른 회원이 쓰고 있으면 409 `github_account_in_use`), 회원은 GitHub 계정 하나(바꾸면 교체).
 *
 * 저장소 연결(owner)
 * 1. `POST /projects/:id/github/install` → state(install, 과제에 묶임) + 앱 설치 주소 `github.com/apps/<slug>/installations/new?state=`.
 * 2. GitHub → `GET /github/setup?installation_id&state` → state 확인 → installation id를 **믿지 않고** state(install_verify)를 새로 만들어 사용자 인증으로 보냄.
 * 3. GitHub → OAuth 콜백 → 사용자 토큰으로 `GET /user/installations/{id}/repositories`(그 사람이 그 설치에서 접근할 수 있는 저장소)와
 *    앱 설치 토큰으로 `GET /installation/repositories`의 **교집합**만 고르기 목록(state select, 30분)에 저장 → 토큰 폐기.
 *    다른 사람의 installation id를 주소에 넣어도 그 사람이 접근할 수 없는 설치면 404·403으로 실패합니다(`installation_not_accessible`).
 * 4. `POST /projects/:id/github/link {repoId}` → 고르기 목록에 있는지 + 지금도 설치에 들어 있는지 다시 확인 → 연결(과제당 하나, 저장소도 한 과제에만).
 *
 * 해제
 * - owner의 저장소 해제: 수집 중단(웹훅은 연결 없는 저장소를 무시), 그 연결의 근거 후보 삭제(선언 근거에는 주소·제목만 남음), 메모리의 설치 토큰 폐기.
 * - 회원의 계정 해제: integrations 행 삭제(이미 받은 후보는 남지만 그 사람 것으로 보이지 않음). GitHub 쪽 앱 권한 철회는 GitHub 설정에서 합니다.
 *
 * 스터디 기록(kind = study)은 익명 이름(C-08)과 맞지 않아 GitHub 연결을 쓰지 않습니다(404).
 */
import { z } from 'zod'
import {
  and,
  claimEvidence,
  desc,
  eq,
  githubItems,
  githubOauthStates,
  githubRepoLinks,
  gt,
  inArray,
  integrations,
  isNull,
  type DbExecutor,
  type GithubRepoChoice,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, ServiceError, conflict, forbidden, gone, invalid, notFound, sqlState } from '../errors'
import { loadReadableProject, type ProjectRow } from '../projects/access'
import { parseInput } from '../validation'
import { GITHUB_WEB, type GithubClient, type GithubRepo } from './client'
import type { GithubAppConfig } from './config'
import { type StateRow, consumeState, createState } from './states'
import type { GithubIdentityDto, GithubRedirectDto, ProjectGithubDto } from '../../../shared/types/api'

export const OAUTH_CALLBACK_PATH = '/api/v1/github/oauth/callback'

export interface GithubContext {
  config: GithubAppConfig
  client: GithubClient
  /** 링크 생성 기준 origin(NUXT_SITE_ORIGIN 첫 항목). OAuth redirect_uri를 만듭니다. */
  siteOrigin: string
  now?: Date
}

const redirectUri = (ctx: GithubContext) => `${ctx.siteOrigin}${OAUTH_CALLBACK_PATH}`

function authorizeUrl(ctx: GithubContext, state: string): string {
  const params = new URLSearchParams({ client_id: ctx.config.clientId, redirect_uri: redirectUri(ctx), state, allow_signup: 'false' })
  return `${GITHUB_WEB}/login/oauth/authorize?${params}`
}

// ── 회원 계정 ─────────────────────────────────────────────────────────────

async function findIdentityRow(db: DbExecutor, userId: string) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, 'github'), isNull(integrations.revokedAt)))
    .limit(1)
  return row ?? null
}

/** 회원의 GitHub 사용자 번호(연결하지 않았으면 null). */
export async function githubIdOf(db: DbExecutor, userId: string): Promise<number | null> {
  const row = await findIdentityRow(db, userId)
  return row ? Number(row.externalId) : null
}

export async function getGithubIdentity(db: DbExecutor, actor: Actor): Promise<GithubIdentityDto> {
  const row = await findIdentityRow(db, actor.userId)
  return { linked: !!row, login: row?.externalLogin ?? null, linkedAt: row?.linkedAt.toISOString() ?? null }
}

export async function startIdentityLink(db: DbExecutor, actor: Actor, ctx: GithubContext): Promise<GithubRedirectDto> {
  const { state } = await createState(db, { purpose: 'identity', userId: actor.userId }, ctx.now ?? new Date())
  return { url: authorizeUrl(ctx, state) }
}

export async function unlinkGithubIdentity(db: DbExecutor, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .delete(integrations)
      .where(and(eq(integrations.userId, actor.userId), eq(integrations.provider, 'github')))
      .returning({ id: integrations.id })
    for (const row of rows) {
      await recordAudit(tx, { actorId: actor.userId, action: 'github.identity_unlink', targetType: 'integration', targetId: row.id })
    }
  })
}

async function linkIdentity(db: DbExecutor, userId: string, user: { id: number; login: string }, now: Date): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ userId: integrations.userId })
        .from(integrations)
        .where(and(eq(integrations.provider, 'github'), eq(integrations.externalId, String(user.id)), isNull(integrations.revokedAt)))
        .limit(1)
      if (taken && taken.userId !== userId) throw conflict('github_account_in_use')
      const removed = await tx
        .delete(integrations)
        .where(and(eq(integrations.userId, userId), eq(integrations.provider, 'github')))
        .returning({ id: integrations.id })
      const [row] = await tx
        .insert(integrations)
        .values({ userId, provider: 'github', externalId: String(user.id), externalLogin: user.login, linkedAt: now })
        .returning({ id: integrations.id })
      await recordAudit(tx, {
        actorId: userId,
        action: 'github.identity_link',
        targetType: 'integration',
        targetId: row?.id ?? null,
        metadata: { relinked: removed.length > 0 },
      })
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('github_account_in_use')
    throw error
  }
}

// ── 과제 저장소 ───────────────────────────────────────────────────────────

/** GitHub 연결을 쓸 수 있는 과제(멤버만, 스터디 기록 제외). */
async function loadGithubProject(db: DbExecutor, actor: Actor, projectId: unknown, options: { lock?: boolean } = {}) {
  const context = await loadReadableProject(db, actor, projectId, options)
  if (context.project.kind === 'study') throw notFound()
  return context
}

function requireOwner(context: { project: ProjectRow; membership: { role: string; status: string } }) {
  if (context.membership.role !== 'owner' || context.membership.status !== 'active') throw forbidden()
}

export async function activeLink(db: DbExecutor, projectId: string) {
  const [row] = await db
    .select()
    .from(githubRepoLinks)
    .where(and(eq(githubRepoLinks.projectId, projectId), isNull(githubRepoLinks.unlinkedAt)))
    .limit(1)
  return row ?? null
}

async function pendingSelection(db: DbExecutor, userId: string, projectId: string, now: Date) {
  const [row] = await db
    .select()
    .from(githubOauthStates)
    .where(
      and(
        eq(githubOauthStates.userId, userId),
        eq(githubOauthStates.projectId, projectId),
        eq(githubOauthStates.purpose, 'select'),
        isNull(githubOauthStates.usedAt),
        gt(githubOauthStates.expiresAt, now),
      ),
    )
    .orderBy(desc(githubOauthStates.createdAt))
    .limit(1)
  return row ?? null
}

export async function getProjectGithub(db: DbExecutor, actor: Actor, projectId: unknown, now = new Date()): Promise<ProjectGithubDto> {
  const context = await loadGithubProject(db, actor, projectId)
  const isOwner = context.membership.role === 'owner'
  const [link, pending, identity] = await Promise.all([
    activeLink(db, context.project.id),
    isOwner ? pendingSelection(db, actor.userId, context.project.id, now) : Promise.resolve(null),
    findIdentityRow(db, actor.userId),
  ])
  return {
    link: link ? { fullName: link.fullName, htmlUrl: link.htmlUrl, private: link.isPrivate, linkedAt: link.linkedAt.toISOString() } : null,
    pendingChoices: !link && pending?.repos ? pending.repos.map((r) => ({ id: r.id, fullName: r.fullName, private: r.private })) : null,
    canManage: isOwner,
    identityLinked: !!identity,
  }
}

export async function startInstall(db: DbExecutor, actor: Actor, projectId: unknown, ctx: GithubContext): Promise<GithubRedirectDto> {
  const context = await loadGithubProject(db, actor, projectId)
  requireOwner(context)
  if (await activeLink(db, context.project.id)) throw conflict('already_linked')
  const { state } = await createState(db, { purpose: 'install', userId: actor.userId, projectId: context.project.id }, ctx.now ?? new Date())
  return { url: `${GITHUB_WEB}/apps/${encodeURIComponent(ctx.config.slug)}/installations/new?${new URLSearchParams({ state })}` }
}

const installationIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/**
 * 설치 뒤 돌아온 요청(Setup URL). 결과는 이동할 주소입니다. installation id는 여기서 믿지 않고 사용자 인증(OAuth)으로 확인하러 보냅니다.
 * 조직 관리자 승인을 기다리는 설치 요청(`setup_action=request`)이면 과제 화면으로 돌려보내 안내합니다.
 */
export async function handleSetup(
  db: DbExecutor,
  actor: Actor,
  query: { installation_id?: unknown; state?: unknown; setup_action?: unknown },
  ctx: GithubContext,
): Promise<{ redirect: string }> {
  const now = ctx.now ?? new Date()
  const row = await consumeState(db, query.state, ['install'], actor.userId, now)
  if (!row?.projectId) throw gone('github_state_invalid')
  const projectId = row.projectId
  return withProject(projectId, async () => {
    const context = await loadGithubProject(db, actor, projectId)
    requireOwner(context)
    if (query.setup_action === 'request') return { redirect: projectRedirect(projectId, 'requested') }
    const parsed = installationIdSchema.safeParse(query.installation_id)
    if (!parsed.success) throw gone('github_state_invalid')
    const { state } = await createState(db, { purpose: 'install_verify', userId: actor.userId, projectId, installationId: parsed.data }, now)
    return { redirect: authorizeUrl(ctx, state) }
  })
}

/**
 * 화면 이동 경로의 실패에 과제 id를 붙입니다(오류 화면을 그 과제로 보내려고). 과제를 읽을 수 없게 된 경우(404)는 붙이지 않습니다.
 */
export class GithubFlowError extends Error {
  constructor(
    readonly original: unknown,
    readonly projectId: string | null,
  ) {
    super('github flow failed')
    this.name = 'GithubFlowError'
  }
}

async function withProject<T>(projectId: string | null, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (projectId === null) throw error
    const visible = !(error instanceof ServiceError && error.code === 'NOT_FOUND')
    throw new GithubFlowError(error, visible ? projectId : null)
  }
}

export const projectRedirect = (projectId: string, result: string) => `/projects/${projectId}?github=${encodeURIComponent(result)}#github`
export const identityRedirect = (result: string) => `/onboarding?github=${encodeURIComponent(result)}#github`

const codeSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+$/)

/**
 * OAuth 콜백(회원 연결·설치 확인 공통). 사용자 토큰은 이 함수 안에서만 쓰고 끝나면 폐기합니다.
 * 결과는 이동할 화면 주소. state가 없거나 맞지 않으면 410 `github_state_invalid`.
 */
export async function completeOAuth(
  db: DbExecutor,
  actor: Actor,
  query: { code?: unknown; state?: unknown },
  ctx: GithubContext,
): Promise<{ redirect: string }> {
  const now = ctx.now ?? new Date()
  const row = await consumeState(db, query.state, ['identity', 'install_verify'], actor.userId, now)
  if (!row) throw gone('github_state_invalid')
  return withProject(row.projectId, () => finishOAuth(db, actor, row, query.code, ctx, now))
}

async function finishOAuth(db: DbExecutor, actor: Actor, row: StateRow, rawCode: unknown, ctx: GithubContext, now: Date): Promise<{ redirect: string }> {
  const code = codeSchema.safeParse(rawCode)
  if (!code.success) throw gone('github_state_invalid')
  if (row.purpose === 'install_verify') {
    // 설치를 시작한 뒤 owner가 바뀌었으면 여기서 멈춥니다(네트워크 호출 전에).
    requireOwner(await loadGithubProject(db, actor, row.projectId))
  }
  const token = await ctx.client.exchangeCode(code.data, redirectUri(ctx))
  if (!token) throw gone('github_state_invalid')
  try {
    if (row.purpose === 'identity') {
      const user = await ctx.client.getUser(token)
      await linkIdentity(db, actor.userId, user, now)
      return { redirect: identityRedirect('linked') }
    }
    const installationId = row.installationId!
    const projectId = row.projectId!
    const userRepos = await ctx.client.listUserInstallationRepos(token, installationId)
    if (!userRepos) throw forbidden('installation_not_accessible')
    const appRepos = await ctx.client.listInstallationRepos(installationId)
    if (!appRepos) throw forbidden('installation_not_accessible')
    const appById = new Map(appRepos.map((repo) => [repo.id, repo]))
    const choices: GithubRepoChoice[] = userRepos
      .filter((repo) => appById.has(repo.id))
      .map((repo) => {
        const app = appById.get(repo.id)!
        return { id: app.id, fullName: app.fullName, htmlUrl: app.htmlUrl, private: app.private }
      })
      .slice(0, 200)
    if (choices.length === 0) return { redirect: projectRedirect(projectId, 'no_repositories') }
    await db.transaction(async (tx) => {
      // 앞서 만든 고르기 목록은 닫습니다(가장 최근 확인만 유효).
      await tx
        .update(githubOauthStates)
        .set({ usedAt: now })
        .where(
          and(
            eq(githubOauthStates.userId, actor.userId),
            eq(githubOauthStates.projectId, projectId),
            eq(githubOauthStates.purpose, 'select'),
            isNull(githubOauthStates.usedAt),
          ),
        )
      await createState(tx, { purpose: 'select', userId: actor.userId, projectId, installationId, repos: choices }, now)
    })
    return { redirect: projectRedirect(projectId, 'select') }
  } finally {
    await ctx.client.revokeUserToken(token)
  }
}

const linkSchema = z.object({ repoId: z.number({ error: 'required' }).int({ error: 'invalid' }).positive({ error: 'invalid' }) })

/** owner가 확인된 목록에서 저장소 하나를 연결합니다. */
export async function linkRepository(db: DbExecutor, actor: Actor, projectId: unknown, rawInput: unknown, ctx: GithubContext): Promise<ProjectGithubDto> {
  const now = ctx.now ?? new Date()
  const input = parseInput(linkSchema, rawInput)
  const context = await loadGithubProject(db, actor, projectId)
  requireOwner(context)
  const selection = await pendingSelection(db, actor.userId, context.project.id, now)
  if (!selection?.repos || !selection.installationId) throw gone('github_selection_expired')
  const choice = selection.repos.find((repo) => repo.id === input.repoId)
  if (!choice) throw invalid({ repoId: 'not_found' })
  // 고른 뒤 설치에서 빠졌을 수 있어 지금 다시 확인합니다(네트워크는 트랜잭션 밖에서).
  const current: GithubRepo[] | null = await ctx.client.listInstallationRepos(selection.installationId)
  const repo = current?.find((r) => r.id === choice.id)
  if (!repo) throw forbidden('installation_not_accessible')
  try {
    await db.transaction(async (tx) => {
      const locked = await loadGithubProject(tx, actor, context.project.id, { lock: true })
      requireOwner(locked)
      if (await activeLink(tx, locked.project.id)) throw conflict('already_linked')
      const used = await tx
        .update(githubOauthStates)
        .set({ usedAt: now })
        .where(and(eq(githubOauthStates.id, selection.id), isNull(githubOauthStates.usedAt)))
        .returning({ id: githubOauthStates.id })
      if (used.length !== 1) throw gone('github_selection_expired')
      const [link] = await tx
        .insert(githubRepoLinks)
        .values({
          projectId: locked.project.id,
          installationId: selection.installationId!,
          repoId: repo.id,
          fullName: repo.fullName,
          htmlUrl: repo.htmlUrl,
          isPrivate: repo.private,
          linkedBy: actor.userId,
          linkedAt: now,
        })
        .returning({ id: githubRepoLinks.id })
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'github.repo_link',
        targetType: 'github_repo_link',
        targetId: link?.id ?? null,
        projectId: locked.project.id,
        metadata: { repoId: repo.id, private: repo.private },
      })
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('repo_in_use')
    throw error
  }
  return getProjectGithub(db, actor, context.project.id, now)
}

export type UnlinkReason = 'owner' | 'uninstalled' | 'repo_removed' | 'project_purged'

/**
 * 연결들을 끊습니다(트랜잭션 안에서): 선언 근거의 후보 참조를 비우고(주소·제목은 남음) 후보 행을 지운 뒤 연결 행에 해제 시각·이유를 남깁니다.
 * 끊은 연결의 설치 id 목록을 돌려줍니다(커밋 뒤 설치 토큰 폐기용).
 */
export async function detachLinks(tx: DbExecutor, linkIds: readonly string[], reason: UnlinkReason, now: Date): Promise<number[]> {
  if (linkIds.length === 0) return []
  const ids = [...linkIds]
  const itemIds = (await tx.select({ id: githubItems.id }).from(githubItems).where(inArray(githubItems.linkId, ids))).map((r) => r.id)
  if (itemIds.length > 0) {
    await tx.update(claimEvidence).set({ githubItemId: null }).where(inArray(claimEvidence.githubItemId, itemIds))
    await tx.delete(githubItems).where(inArray(githubItems.id, itemIds))
  }
  const rows = await tx
    .update(githubRepoLinks)
    .set({ unlinkedAt: now, unlinkReason: reason })
    .where(and(inArray(githubRepoLinks.id, ids), isNull(githubRepoLinks.unlinkedAt)))
    .returning({ installationId: githubRepoLinks.installationId })
  return [...new Set(rows.map((r) => r.installationId))]
}

/** 다른 연결이 더 쓰지 않는 설치의 메모리 토큰을 폐기합니다(커밋 뒤). */
export async function forgetUnusedInstallations(db: DbExecutor, client: GithubClient, installationIds: readonly number[]): Promise<void> {
  for (const installationId of installationIds) {
    const [still] = await db
      .select({ id: githubRepoLinks.id })
      .from(githubRepoLinks)
      .where(and(eq(githubRepoLinks.installationId, installationId), isNull(githubRepoLinks.unlinkedAt)))
      .limit(1)
    if (!still) await client.forgetInstallation(installationId)
  }
}

/** owner의 저장소 연결 해제(없어도 성공). */
export async function unlinkRepository(db: DbExecutor, actor: Actor, projectId: unknown, ctx: Pick<GithubContext, 'client' | 'now'>): Promise<void> {
  const now = ctx.now ?? new Date()
  const installations = await db.transaction(async (tx) => {
    const context = await loadGithubProject(tx, actor, projectId, { lock: true })
    requireOwner(context)
    const link = await activeLink(tx, context.project.id)
    if (!link) return []
    const freed = await detachLinks(tx, [link.id], 'owner', now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'github.repo_unlink',
      targetType: 'github_repo_link',
      targetId: link.id,
      projectId: context.project.id,
      metadata: { reason: 'owner' },
    })
    return freed
  })
  await forgetUnusedInstallations(db, ctx.client, installations)
}

/** 이 과제에 연결했던(지금·이전) 비공개 저장소 주소. 공개 전 점검(`github_private`)이 씁니다. */
export async function privateRepoUrlsOf(db: DbExecutor, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ htmlUrl: githubRepoLinks.htmlUrl })
    .from(githubRepoLinks)
    .where(and(eq(githubRepoLinks.projectId, projectId), eq(githubRepoLinks.isPrivate, true)))
  return [...new Set(rows.map((r) => r.htmlUrl))]
}

