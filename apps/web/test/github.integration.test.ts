/**
 * E-11 GitHub App 연동 통합 테스트(실제 PostgreSQL, 네트워크 없음). DATABASE_URL이 없으면 건너뜁니다.
 * GitHub API는 가짜 클라이언트(GithubClient 인터페이스)로 바꾸고 호출만 기록합니다. 각 테스트는 rollback 트랜잭션 안에서 자기 행만 봅니다.
 */
import { generateKeyPairSync, randomInt } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  and,
  auditEvents,
  claimEvidence,
  eq,
  githubItems,
  githubOauthStates,
  githubRepoLinks,
  githubWebhookDeliveries,
  integrations,
  type DbExecutor,
} from '@peerchive/db'
import { createClaim, listClaims, reviseClaim } from '../server/modules/contribution/claims'
import { signWebhookBody } from '../server/modules/github/app-auth'
import type { GithubClient, GithubRepo } from '../server/modules/github/client'
import type { GithubAppConfig } from '../server/modules/github/config'
import {
  GithubFlowError,
  completeOAuth,
  getGithubIdentity,
  getProjectGithub,
  handleSetup,
  linkRepository,
  startIdentityLink,
  startInstall,
  unlinkGithubIdentity,
  unlinkRepository,
  type GithubContext,
} from '../server/modules/github/connect'
import { listGithubCandidates } from '../server/modules/github/items'
import { MAX_WEBHOOK_BODY_BYTES, WebhookRejected, receiveWebhook } from '../server/modules/github/webhook'
import { createLog } from '../server/modules/logs/logs'
import { createCandidate, previewCandidate } from '../server/modules/publication/candidates'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const SITE = 'http://localhost:3100'
const T0 = new Date('2026-11-02T03:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const SECRET = 'whsec-test-0123456789abcdefghijklmnopqrstuvwxyz'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const CONFIG: GithubAppConfig = {
  appId: '12345',
  privateKey,
  webhookSecret: SECRET,
  slug: 'peerchive-test',
  clientId: 'Iv1.testclient',
  clientSecret: 'test-client-secret',
}

/** 테스트마다 겹치지 않는 GitHub 번호. */
const gid = () => randomInt(1_000_000, 2 ** 40)

const repo = (id: number, name: string, isPrivate = true): GithubRepo => ({
  id,
  fullName: `team-${id}/${name}`,
  htmlUrl: `https://github.com/team-${id}/${name}`,
  private: isPrivate,
})

/** 가짜 GitHub. 호출만 기록하고 미리 넣은 값을 돌려줍니다. */
function fakeGithub() {
  const calls: string[] = []
  const users = new Map<string, { id: number; login: string }>()
  const userRepos = new Map<number, GithubRepo[] | null>()
  const appRepos = new Map<number, GithubRepo[] | null>()
  const installations = new Map<number, { id: number; suspended: boolean } | null>()
  const client: GithubClient = {
    async getInstallation(id) {
      calls.push(`getInstallation:${id}`)
      return installations.has(id) ? installations.get(id)! : { id, suspended: false }
    },
    async listInstallationRepos(id) {
      calls.push(`listInstallationRepos:${id}`)
      return appRepos.get(id) ?? null
    },
    async exchangeCode(code, redirectUri) {
      calls.push(`exchangeCode:${redirectUri}`)
      return users.has(code) ? `token-${code}` : null
    },
    async getUser(token) {
      calls.push('getUser')
      return users.get(token.replace(/^token-/, ''))!
    },
    async listUserInstallationRepos(_token, id) {
      calls.push(`listUserInstallationRepos:${id}`)
      return userRepos.get(id) ?? null
    },
    async revokeUserToken(token) {
      calls.push(`revoke:${token}`)
    },
    async forgetInstallation(id) {
      calls.push(`forget:${id}`)
    },
  }
  return { client, calls, users, userRepos, appRepos, installations }
}

type Fake = ReturnType<typeof fakeGithub>
const ctxOf = (fake: Fake, now = T0): GithubContext => ({ config: CONFIG, client: fake.client, siteOrigin: SITE, now })
const stateOf = (url: string) => new URL(url).searchParams.get('state')!

async function team(db: DbExecutor, roles: Array<'editor' | 'reviewer' | 'viewer'> = ['editor']) {
  const owner = await createUser(db, { displayName: '김소유' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' }, T0)
  const members = []
  for (const role of roles) {
    const user = await createUser(db, { displayName: role === 'editor' ? '이편집' : role })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members.push(user)
  }
  return { owner, project, members }
}

/** OAuth로 회원 GitHub 계정을 연결합니다. */
async function linkIdentity(db: DbExecutor, fake: Fake, userId: string, user = { id: gid(), login: `user${randomInt(1, 1e9)}` }) {
  const { url } = await startIdentityLink(db, { userId }, ctxOf(fake))
  const code = `code${randomInt(1, 1e9)}`
  fake.users.set(code, user)
  expect(await completeOAuth(db, { userId }, { code, state: stateOf(url) }, ctxOf(fake))).toEqual({ redirect: '/onboarding?github=linked#github' })
  return user
}

/** owner가 설치 → 확인 → 저장소 하나 연결까지. */
async function linkRepo(db: DbExecutor, fake: Fake, ownerId: string, projectId: string, chosen = repo(gid(), 'capstone')) {
  const installationId = gid()
  fake.userRepos.set(installationId, [chosen])
  fake.appRepos.set(installationId, [chosen])
  const { url } = await startInstall(db, { userId: ownerId }, projectId, ctxOf(fake))
  const setup = await handleSetup(db, { userId: ownerId }, { installation_id: String(installationId), setup_action: 'install', state: stateOf(url) }, ctxOf(fake))
  const code = `code${randomInt(1, 1e9)}`
  fake.users.set(code, { id: gid(), login: 'installer' })
  expect(await completeOAuth(db, { userId: ownerId }, { code, state: stateOf(setup.redirect) }, ctxOf(fake))).toEqual({
    redirect: `/projects/${projectId}?github=select#github`,
  })
  await linkRepository(db, { userId: ownerId }, projectId, { repoId: chosen.id }, ctxOf(fake))
  return { installationId, repo: chosen }
}

function delivery(event: string, payload: unknown, options: { secret?: string | null; deliveryId?: string; signature?: string | null } = {}) {
  const body = Buffer.from(JSON.stringify(payload))
  return {
    event,
    deliveryId: options.deliveryId ?? crypto.randomUUID(),
    signature: options.signature === undefined ? signWebhookBody(options.secret ?? SECRET, body) : options.signature,
    body,
  }
}

const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')

function pushPayload(installationId: number, r: GithubRepo, sender: { id: number; login: string }, commits: Array<{ sha?: string; message: string; username?: string; distinct?: boolean }>) {
  return {
    ref: 'refs/heads/main',
    installation: { id: installationId },
    repository: { id: r.id, full_name: r.fullName, private: r.private },
    sender,
    commits: commits.map((c) => ({
      id: c.sha ?? sha(),
      distinct: c.distinct ?? true,
      message: c.message,
      timestamp: '2026-11-02T12:00:00+09:00',
      url: `${r.htmlUrl}/commit/${c.sha ?? 'x'}`,
      author: { name: '실명 노출 금지', email: 'secret-author@example.com', username: c.username ?? sender.login },
      added: ['src/secret.ts'],
      modified: [],
      removed: [],
    })),
  }
}

function prPayload(installationId: number, r: GithubRepo, authorId: number, number: number, action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    number,
    installation: { id: installationId },
    repository: { id: r.id, full_name: r.fullName },
    sender: { id: authorId, login: 'someone' },
    pull_request: {
      number,
      title: `로그인 API 추가\n\n본문은 저장하지 않음`,
      body: 'PR 본문 SECRET_BODY',
      html_url: `${r.htmlUrl}/pull/${number}`,
      user: { id: authorId, login: 'someone' },
      state: 'open',
      merged: false,
      created_at: '2026-11-02T03:00:00Z',
      updated_at: '2026-11-02T03:00:00Z',
      ...extra,
    },
  }
}

const deps = (fake: Fake, secret: string | null = SECRET) => ({ secret, client: fake.client })

async function rejected(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(WebhookRejected)
  expect(error).toMatchObject({ status, code })
}

describe.skipIf(!databaseUrl)('E-11 GitHub App integration (PostgreSQL, mocked GitHub)', () => {
  afterAll(closeTestDb)

  describe('member identity (user-to-server OAuth)', () => {
    it('links the GitHub user id and login only, revokes the user token and never stores it', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const user = await createUser(tx)
        const { url } = await startIdentityLink(tx, { userId: user.id }, ctxOf(fake))
        const parsed = new URL(url)
        expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize')
        expect(parsed.searchParams.get('client_id')).toBe(CONFIG.clientId)
        expect(parsed.searchParams.get('redirect_uri')).toBe(`${SITE}/api/v1/github/oauth/callback`)
        // state 원문은 저장하지 않습니다.
        const stored = await tx.select().from(githubOauthStates).where(eq(githubOauthStates.userId, user.id))
        expect(stored).toHaveLength(1)
        expect(JSON.stringify(stored)).not.toContain(stateOf(url))

        fake.users.set('abc', { id: 4242, login: 'octo-student' })
        await completeOAuth(tx, { userId: user.id }, { code: 'abc', state: stateOf(url) }, ctxOf(fake))
        expect(fake.calls).toContain('revoke:token-abc')
        expect(await getGithubIdentity(tx, { userId: user.id })).toMatchObject({ linked: true, login: 'octo-student' })
        const rows = await tx.select().from(integrations).where(eq(integrations.userId, user.id))
        expect(rows).toMatchObject([{ provider: 'github', externalId: '4242', externalLogin: 'octo-student' }])
        expect(JSON.stringify(rows)).not.toContain('token-abc')

        await unlinkGithubIdentity(tx, { userId: user.id })
        expect(await tx.select().from(integrations).where(eq(integrations.userId, user.id))).toHaveLength(0)
        expect(await getGithubIdentity(tx, { userId: user.id })).toEqual({ linked: false, login: null, linkedAt: null })
      })
    })

    it('state is single use, expires in 10 minutes and is bound to the user who started it', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const user = await createUser(tx)
        const other = await createUser(tx)
        fake.users.set('c1', { id: gid(), login: 'one' })

        // 만료
        const expired = await startIdentityLink(tx, { userId: user.id }, ctxOf(fake))
        await expectServiceError(completeOAuth(tx, { userId: user.id }, { code: 'c1', state: stateOf(expired.url) }, ctxOf(fake, at(11))), 'GONE', 'github_state_invalid')

        // 다른 사용자의 세션으로는 쓸 수 없고, 만든 사람은 그 뒤에도 쓸 수 있습니다.
        const { url } = await startIdentityLink(tx, { userId: user.id }, ctxOf(fake))
        await expectServiceError(completeOAuth(tx, { userId: other.id }, { code: 'c1', state: stateOf(url) }, ctxOf(fake)), 'GONE', 'github_state_invalid')
        await completeOAuth(tx, { userId: user.id }, { code: 'c1', state: stateOf(url) }, ctxOf(fake, at(9)))

        // 한 번만
        await expectServiceError(completeOAuth(tx, { userId: user.id }, { code: 'c1', state: stateOf(url) }, ctxOf(fake)), 'GONE', 'github_state_invalid')
        // 형식이 틀린 state·잘못된 code
        await expectServiceError(completeOAuth(tx, { userId: user.id }, { code: 'c1', state: 'nope' }, ctxOf(fake)), 'GONE')
        const again = await startIdentityLink(tx, { userId: user.id }, ctxOf(fake))
        await expectServiceError(completeOAuth(tx, { userId: user.id }, { code: 'unknown', state: stateOf(again.url) }, ctxOf(fake)), 'GONE')
        // 회원 연결 state는 설치 단계(setup)에 쓸 수 없습니다.
        const wrongPurpose = await startIdentityLink(tx, { userId: user.id }, ctxOf(fake))
        await expectServiceError(handleSetup(tx, { userId: user.id }, { installation_id: '1', state: stateOf(wrongPurpose.url) }, ctxOf(fake)), 'GONE')
      })
    })

    it('one GitHub account belongs to one member', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const a = await createUser(tx)
        const b = await createUser(tx)
        const shared = { id: gid(), login: 'shared' }
        await linkIdentity(tx, fake, a.id, shared)
        const { url } = await startIdentityLink(tx, { userId: b.id }, ctxOf(fake))
        fake.users.set('dup', shared)
        await expectServiceError(completeOAuth(tx, { userId: b.id }, { code: 'dup', state: stateOf(url) }, ctxOf(fake)), 'CONFLICT', 'github_account_in_use')
        // 거부되어도 사용자 토큰은 폐기합니다.
        expect(fake.calls).toContain('revoke:token-dup')
      })
    })
  })

  describe('repository installation flow', () => {
    it('verifies the installation through the installing user and offers only repositories both can reach', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project, members } = await team(tx)
        const editor = members[0]!
        await expectServiceError(startInstall(tx, { userId: editor.id }, project.id, ctxOf(fake)), 'FORBIDDEN')
        await expectServiceError(startInstall(tx, { userId: (await createUser(tx)).id }, project.id, ctxOf(fake)), 'NOT_FOUND')

        const installationId = gid()
        const shared = repo(gid(), 'capstone')
        const userOnly = repo(gid(), 'personal')
        const appOnly = repo(gid(), 'someone-else')
        fake.userRepos.set(installationId, [shared, userOnly])
        fake.appRepos.set(installationId, [shared, appOnly])

        const { url } = await startInstall(tx, { userId: owner.id }, project.id, ctxOf(fake))
        expect(url.startsWith(`https://github.com/apps/${CONFIG.slug}/installations/new?state=`)).toBe(true)
        // state는 사용자에 묶입니다(편집자 세션으로 setup에 쓰면 실패).
        await expectServiceError(handleSetup(tx, { userId: editor.id }, { installation_id: String(installationId), state: stateOf(url) }, ctxOf(fake)), 'GONE')
        const setup = await handleSetup(tx, { userId: owner.id }, { installation_id: String(installationId), setup_action: 'install', state: stateOf(url) }, ctxOf(fake))
        // setup은 installation id를 믿지 않고 사용자 인증으로 보냅니다(GitHub API 호출 없음).
        expect(setup.redirect.startsWith('https://github.com/login/oauth/authorize?')).toBe(true)
        expect(fake.calls).toEqual([])

        fake.users.set('inst', { id: gid(), login: 'installer' })
        await completeOAuth(tx, { userId: owner.id }, { code: 'inst', state: stateOf(setup.redirect) }, ctxOf(fake))
        expect(fake.calls).toEqual([
          `exchangeCode:${SITE}/api/v1/github/oauth/callback`,
          `listUserInstallationRepos:${installationId}`,
          `listInstallationRepos:${installationId}`,
          'revoke:token-inst',
        ])
        // 설치 확인은 회원 계정을 연결하지 않습니다.
        expect(await getGithubIdentity(tx, { userId: owner.id })).toMatchObject({ linked: false })

        const status = await getProjectGithub(tx, { userId: owner.id }, project.id, T0)
        expect(status.pendingChoices).toEqual([{ id: shared.id, fullName: shared.fullName, private: true }])
        // 고르기 목록은 owner에게만.
        expect((await getProjectGithub(tx, { userId: editor.id }, project.id, T0)).pendingChoices).toBeNull()

        await expectServiceError(linkRepository(tx, { userId: owner.id }, project.id, { repoId: userOnly.id }, ctxOf(fake)), 'VALIDATION')
        await expectServiceError(linkRepository(tx, { userId: editor.id }, project.id, { repoId: shared.id }, ctxOf(fake)), 'FORBIDDEN')
        const linked = await linkRepository(tx, { userId: owner.id }, project.id, { repoId: shared.id }, ctxOf(fake))
        expect(linked.link).toMatchObject({ fullName: shared.fullName, htmlUrl: shared.htmlUrl, private: true })
        expect(linked.pendingChoices).toBeNull()
        // 고르기는 한 번만, 이미 연결이면 새 설치도 409.
        await expectServiceError(linkRepository(tx, { userId: owner.id }, project.id, { repoId: shared.id }, ctxOf(fake)), 'GONE', 'github_selection_expired')
        await expectServiceError(startInstall(tx, { userId: owner.id }, project.id, ctxOf(fake)), 'CONFLICT', 'already_linked')

        const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.projectId, project.id), eq(auditEvents.action, 'github.repo_link')))
        expect(audit).toHaveLength(1)
        expect(JSON.stringify(audit[0]!.metadata)).not.toContain(shared.fullName)

        // 같은 저장소는 다른 과제에 연결할 수 없습니다.
        const second = await team(tx, [])
        const again = gid()
        fake.userRepos.set(again, [shared])
        fake.appRepos.set(again, [shared])
        const start2 = await startInstall(tx, { userId: second.owner.id }, second.project.id, ctxOf(fake))
        const setup2 = await handleSetup(tx, { userId: second.owner.id }, { installation_id: String(again), state: stateOf(start2.url) }, ctxOf(fake))
        fake.users.set('inst2', { id: gid(), login: 'installer2' })
        await completeOAuth(tx, { userId: second.owner.id }, { code: 'inst2', state: stateOf(setup2.redirect) }, ctxOf(fake))
        await expectServiceError(linkRepository(tx, { userId: second.owner.id }, second.project.id, { repoId: shared.id }, ctxOf(fake)), 'CONFLICT', 'repo_in_use')
      })
    })

    it('rejects an installation id the user cannot access (forged setup redirect)', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project } = await team(tx, [])
        const foreignInstallation = gid()
        fake.appRepos.set(foreignInstallation, [repo(gid(), 'victim')])
        // 사용자는 이 설치에 접근할 수 없습니다(GitHub가 404).
        fake.userRepos.set(foreignInstallation, null)
        const { url } = await startInstall(tx, { userId: owner.id }, project.id, ctxOf(fake))
        const setup = await handleSetup(tx, { userId: owner.id }, { installation_id: String(foreignInstallation), state: stateOf(url) }, ctxOf(fake))
        fake.users.set('evil', { id: gid(), login: 'evil' })
        const error = await completeOAuth(tx, { userId: owner.id }, { code: 'evil', state: stateOf(setup.redirect) }, ctxOf(fake)).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(GithubFlowError)
        expect((error as GithubFlowError).projectId).toBe(project.id)
        expect((error as GithubFlowError).original).toMatchObject({ code: 'FORBIDDEN', reason: 'installation_not_accessible' })
        expect(fake.calls).toContain('revoke:token-evil')
        expect((await getProjectGithub(tx, { userId: owner.id }, project.id, T0)).pendingChoices).toBeNull()
        // 고르기가 없으면 연결할 수 없습니다.
        await expectServiceError(linkRepository(tx, { userId: owner.id }, project.id, { repoId: 1 }, ctxOf(fake)), 'GONE', 'github_selection_expired')
      })
    })

    it('re-checks the installation at link time and keeps study records out', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project } = await team(tx, [])
        const installationId = gid()
        const r = repo(gid(), 'capstone')
        fake.userRepos.set(installationId, [r])
        fake.appRepos.set(installationId, [r])
        const { url } = await startInstall(tx, { userId: owner.id }, project.id, ctxOf(fake))
        const setup = await handleSetup(tx, { userId: owner.id }, { installation_id: String(installationId), state: stateOf(url) }, ctxOf(fake))
        fake.users.set('k', { id: gid(), login: 'k' })
        await completeOAuth(tx, { userId: owner.id }, { code: 'k', state: stateOf(setup.redirect) }, ctxOf(fake))
        // 고른 뒤 설치에서 빠짐
        fake.appRepos.set(installationId, [])
        await expectServiceError(linkRepository(tx, { userId: owner.id }, project.id, { repoId: r.id }, ctxOf(fake)), 'FORBIDDEN', 'installation_not_accessible')
        // 고르기 목록은 30분 뒤 만료
        fake.appRepos.set(installationId, [r])
        await expectServiceError(linkRepository(tx, { userId: owner.id }, project.id, { repoId: r.id }, ctxOf(fake, at(31))), 'GONE', 'github_selection_expired')
      })
    })
  })

  describe('webhook', () => {
    it('verifies the signature over the raw body, caps the body and rejects replays', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const ping = { zen: 'hello', hook_id: 1 }
        // 꺼짐(비밀 없음) → 404
        await rejected(receiveWebhook(tx, deps(fake, null), delivery('ping', ping), T0), 404, 'not_found')
        // 서명 없음·틀림·다른 비밀·형식 틀림 → 401
        await rejected(receiveWebhook(tx, deps(fake), delivery('ping', ping, { signature: null }), T0), 401, 'invalid_signature')
        await rejected(receiveWebhook(tx, deps(fake), delivery('ping', ping, { secret: 'other-secret' }), T0), 401, 'invalid_signature')
        await rejected(receiveWebhook(tx, deps(fake), delivery('ping', ping, { signature: 'sha1=abc' }), T0), 401, 'invalid_signature')
        // 본문 한 바이트만 바뀌어도 401(서명은 원문 바이트 기준)
        const good = delivery('ping', ping)
        await rejected(receiveWebhook(tx, deps(fake), { ...good, body: Buffer.from(`${good.body.toString()} `) }, T0), 401, 'invalid_signature')
        // 1MB 초과 → 413(서명 확인 전에)
        const big = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, 'a')
        await rejected(receiveWebhook(tx, deps(fake), { event: 'ping', deliveryId: crypto.randomUUID(), signature: signWebhookBody(SECRET, big), body: big }, T0), 413, 'too_large')
        // 전달 id 없음 → 422
        await rejected(receiveWebhook(tx, deps(fake), { ...good, deliveryId: undefined }, T0), 422, 'invalid_payload')

        // 같은 전달 id는 한 번만
        expect(await receiveWebhook(tx, deps(fake), good, T0)).toEqual({ status: 'ignored' })
        await rejected(receiveWebhook(tx, deps(fake), good, at(1)), 409, 'replayed')
        // 7일이 지나면 기억을 지웁니다.
        await receiveWebhook(tx, deps(fake), delivery('ping', ping), new Date(T0.getTime() + 8 * 24 * 60 * 60 * 1000))
        expect(await tx.select().from(githubWebhookDeliveries).where(eq(githubWebhookDeliveries.deliveryId, good.deliveryId))).toHaveLength(0)
      })
    })

    it('ignores events for repositories that are not linked and stores nothing', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const r = repo(gid(), 'not-linked')
        const sender = { id: gid(), login: 'stranger' }
        expect(await receiveWebhook(tx, deps(fake), delivery('push', pushPayload(gid(), r, sender, [{ message: 'x' }])), T0)).toEqual({ status: 'ignored' })
        expect(await receiveWebhook(tx, deps(fake), delivery('pull_request', prPayload(gid(), r, sender.id, 1, 'opened')), T0)).toEqual({ status: 'ignored' })
        const stored = await tx.select().from(githubItems).where(eq(githubItems.authorGithubId, sender.id))
        expect(stored).toHaveLength(0)
      })
    })

    it('stores minimal commit and PR fields attributed to linked members, never contents or emails', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project, members } = await team(tx)
        const editor = members[0]!
        const { installationId, repo: r } = await linkRepo(tx, fake, owner.id, project.id)
        const editorGithub = await linkIdentity(tx, fake, editor.id)
        const pusher = { id: gid(), login: 'pusher-bot' }
        const s1 = sha()
        const long = '가'.repeat(250)
        const push = pushPayload(installationId, r, pusher, [
          { sha: s1, message: '로그인 API 추가\n\n본문 SECRET_COMMIT_BODY', username: editorGithub.login.toUpperCase() },
          { message: long, username: pusher.login },
          { message: '알 수 없는 작성자', username: 'nobody-here' },
          { message: '이미 다른 브랜치에 있던 커밋', username: pusher.login, distinct: false },
        ])
        // 설치 id가 다른 같은 저장소 이벤트는 무시합니다.
        expect(await receiveWebhook(tx, deps(fake), delivery('push', { ...push, installation: { id: installationId + 1 } }), T0)).toEqual({ status: 'ignored' })
        expect(await receiveWebhook(tx, deps(fake), delivery('push', push), T0)).toEqual({ status: 'processed' })
        // 같은 내용을 다른 전달 id로 다시 보내도 중복되지 않습니다(멱등).
        await receiveWebhook(tx, deps(fake), delivery('push', push), T0)

        const items = await tx.select().from(githubItems).where(eq(githubItems.projectId, project.id))
        expect(items).toHaveLength(2)
        const editorItem = items.find((i) => i.sha === s1)!
        expect(editorItem).toMatchObject({ kind: 'commit', title: '로그인 API 추가', authorGithubId: editorGithub.id, number: null, prState: null })
        expect(editorItem.url).toBe(`${r.htmlUrl}/commit/${s1}`)
        const longItem = items.find((i) => i.sha !== s1)!
        expect([...longItem.title]).toHaveLength(200)
        expect(longItem.authorGithubId).toBe(pusher.id)
        const raw = JSON.stringify(items)
        for (const secret of ['SECRET_COMMIT_BODY', 'secret-author@example.com', '실명 노출 금지', 'src/secret.ts', 'nobody-here']) expect(raw).not.toContain(secret)

        // PR: 열기 → 병합. 늦게 온 이전 이벤트는 새 상태를 덮지 않습니다.
        await receiveWebhook(tx, deps(fake), delivery('pull_request', prPayload(installationId, r, editorGithub.id, 7, 'opened')), T0)
        await receiveWebhook(
          tx,
          deps(fake),
          delivery('pull_request', prPayload(installationId, r, editorGithub.id, 7, 'closed', { state: 'closed', merged: true, updated_at: '2026-11-03T00:00:00Z' })),
          T0,
        )
        await receiveWebhook(tx, deps(fake), delivery('pull_request', prPayload(installationId, r, editorGithub.id, 7, 'edited', { updated_at: '2026-11-02T05:00:00Z' })), T0)
        const [pr] = await tx.select().from(githubItems).where(and(eq(githubItems.projectId, project.id), eq(githubItems.number, 7)))
        expect(pr).toMatchObject({ kind: 'pull_request', title: '로그인 API 추가', prState: 'merged', sha: null, authorGithubId: editorGithub.id })
        expect(JSON.stringify(pr)).not.toContain('SECRET_BODY')

        // 멤버별 후보: 연결한 멤버의 것만, 연결하지 않은 owner는 빈 목록. 비멤버 404.
        const candidates = await listGithubCandidates(tx, { userId: owner.id }, project.id)
        expect(candidates.linked).toBe(true)
        const byName = Object.fromEntries(candidates.members.map((m) => [m.member.displayName, m]))
        expect(byName['김소유']).toMatchObject({ identityLinked: false, items: [] })
        expect(byName['이편집']!.items.map((i) => i.ref).sort()).toEqual(['#7', s1.slice(0, 7)].sort())
        const mine = await listGithubCandidates(tx, { userId: editor.id }, project.id, { mine: true })
        expect(mine.members.map((m) => m.member.userId)).toEqual([editor.id])
        await expectServiceError(listGithubCandidates(tx, { userId: (await createUser(tx)).id }, project.id), 'NOT_FOUND')
      })
    })

    it('unlinks on installation removal only after GitHub confirms, and drops identities on authorization revoke', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project, members } = await team(tx)
        const { installationId, repo: r } = await linkRepo(tx, fake, owner.id, project.id)
        const editorGithub = await linkIdentity(tx, fake, members[0]!.id)
        await receiveWebhook(tx, deps(fake), delivery('push', pushPayload(installationId, r, editorGithub, [{ message: 'a' }])), T0)

        // 서명된 예전 "삭제" 본문을 다시 보내도 설치가 살아 있으면 끊지 않습니다.
        fake.installations.set(installationId, { id: installationId, suspended: false })
        expect(await receiveWebhook(tx, deps(fake), delivery('installation', { action: 'deleted', installation: { id: installationId } }), T0)).toEqual({ status: 'ignored' })
        expect((await getProjectGithub(tx, { userId: owner.id }, project.id)).link).not.toBeNull()
        // 저장소가 아직 설치에 들어 있으면 removed도 무시합니다.
        fake.appRepos.set(installationId, [r])
        const removed = { action: 'removed', installation: { id: installationId }, repositories_removed: [{ id: r.id, full_name: r.fullName }] }
        expect(await receiveWebhook(tx, deps(fake), delivery('installation_repositories', removed), T0)).toEqual({ status: 'ignored' })

        // 공개 → 비공개 전환은 연결에 반영합니다.
        await receiveWebhook(tx, deps(fake), delivery('repository', { action: 'publicized', installation: { id: installationId }, repository: { id: r.id } }), T0)
        expect((await getProjectGithub(tx, { userId: owner.id }, project.id)).link?.private).toBe(false)

        // GitHub가 설치 삭제를 확인하면 연결 해제 + 후보 삭제 + 설치 토큰 폐기.
        fake.installations.set(installationId, null)
        expect(await receiveWebhook(tx, deps(fake), delivery('installation', { action: 'deleted', installation: { id: installationId } }), T0)).toEqual({ status: 'processed' })
        expect((await getProjectGithub(tx, { userId: owner.id }, project.id)).link).toBeNull()
        expect(await tx.select().from(githubItems).where(eq(githubItems.projectId, project.id))).toHaveLength(0)
        const [link] = await tx.select().from(githubRepoLinks).where(eq(githubRepoLinks.projectId, project.id))
        expect(link).toMatchObject({ unlinkReason: 'uninstalled' })
        expect(fake.calls).toContain(`forget:${installationId}`)
        // 이후 push는 무시됩니다.
        expect(await receiveWebhook(tx, deps(fake), delivery('push', pushPayload(installationId, r, editorGithub, [{ message: 'b' }])), T0)).toEqual({ status: 'ignored' })

        // 앱 권한 철회 → 회원 연결 삭제
        expect(await receiveWebhook(tx, deps(fake), delivery('github_app_authorization', { action: 'revoked', sender: { id: editorGithub.id, login: editorGithub.login } }), T0)).toEqual({ status: 'processed' })
        expect(await getGithubIdentity(tx, { userId: members[0]!.id })).toMatchObject({ linked: false })
      })
    })

    it('unlinks a repository removed from the installation once GitHub confirms', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project } = await team(tx, [])
        const { installationId, repo: r } = await linkRepo(tx, fake, owner.id, project.id)
        fake.appRepos.set(installationId, [])
        const removed = { action: 'removed', installation: { id: installationId }, repositories_removed: [{ id: r.id }] }
        expect(await receiveWebhook(tx, deps(fake), delivery('installation_repositories', removed), T0)).toEqual({ status: 'processed' })
        const [link] = await tx.select().from(githubRepoLinks).where(eq(githubRepoLinks.projectId, project.id))
        expect(link).toMatchObject({ unlinkReason: 'repo_removed' })
      })
    })
  })

  describe('evidence candidates, disconnect and publication', () => {
    it('members attach only their own items as claim evidence; disconnect keeps link-only evidence; nothing enters snapshots', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project, members } = await team(tx)
        const editor = members[0]!
        const { installationId, repo: r } = await linkRepo(tx, fake, owner.id, project.id)
        const editorGithub = await linkIdentity(tx, fake, editor.id)
        const ownerGithub = await linkIdentity(tx, fake, owner.id)
        const s1 = sha()
        await receiveWebhook(
          tx,
          deps(fake),
          delivery('push', pushPayload(installationId, r, editorGithub, [{ sha: s1, message: 'SECRET_PRIVATE_TITLE 로그인 구현' }, { message: '소유자 커밋', username: ownerGithub.login }])),
          T0,
        )
        const items = await tx.select().from(githubItems).where(eq(githubItems.projectId, project.id))
        const editorItem = items.find((i) => i.authorGithubId === editorGithub.id)!
        const ownerItem = items.find((i) => i.authorGithubId === ownerGithub.id)!

        // 후보는 자동으로 선언·근거가 되지 않습니다.
        expect(await listClaims(tx, { userId: owner.id }, project.id)).toEqual([])
        // 남의 커밋은 근거로 고를 수 없습니다.
        const fields = async (evidence: unknown) =>
          (await expectServiceError(createClaim(tx, { userId: editor.id }, project.id, { text: 'x', evidence }), 'VALIDATION')).fields
        expect(await fields([{ kind: 'github', id: ownerItem.id }])).toEqual({ evidence: 'not_found' })
        expect(await fields([{ kind: 'github', url: editorItem.url }])).toEqual({ evidence: 'not_found' })
        expect(await fields([{ kind: 'github' }])).toEqual({ 'evidence.0.id': 'required' })
        expect(await fields([{ kind: 'log', id: crypto.randomUUID(), url: 'https://github.com/x' }])).toEqual({ 'evidence.0.url': 'unknown_key' })

        const claim = await createClaim(tx, { userId: editor.id }, project.id, { text: '로그인 API 담당', evidence: [{ kind: 'github', id: editorItem.id }] }, at(1))
        expect(claim.status).toBe('unconfirmed')
        expect(claim.evidence).toEqual([
          { kind: 'github', itemId: editorItem.id, itemKind: 'commit', ref: s1.slice(0, 7), url: editorItem.url, title: editorItem.title },
        ])

        // 로그 링크로 비공개 저장소 주소를 붙이고 공개 후보를 만들면 점검이 경고하고, 선언의 GitHub 근거는 스냅샷에 없습니다.
        const { log } = await createLog(tx, { userId: editor.id }, project.id, { tag: 'progress', body: '구현', links: [{ url: editorItem.url, title: '로그인 커밋' }] }, at(2))
        const candidate = await createCandidate(
          tx,
          { userId: owner.id },
          project.id,
          { level: 'summary', title: '공개 제목', summary: '요약', slug: `gh-${crypto.randomUUID().slice(0, 8)}`, logIds: [log.id], claimIds: [claim.id] },
          at(3),
          { privateOrigins: [SITE] },
        )
        expect(candidate.checks.filter((c) => c.rule === 'github_private')).toMatchObject([{ location: { kind: 'log', field: 'links.0.url' }, sample: r.fullName.toLowerCase() }])
        const preview = await previewCandidate(tx, { userId: owner.id }, candidate.id)
        const serialized = JSON.stringify(preview.snapshot)
        // 커밋 제목(비공개 저장소 내용)은 없고, 커밋 주소는 학생이 로그 링크로 직접 고른 곳에만 있습니다.
        expect(serialized).not.toContain('SECRET_PRIVATE_TITLE')
        expect(serialized.split(s1).length - 1).toBe(1)
        expect(preview.snapshot.claims[0]!.evidence).toEqual([])
        // 학생이 고른 링크(주소·제목)만 들어갑니다.
        expect(preview.snapshot.logs[0]!.links).toEqual([{ url: editorItem.url, title: '로그인 커밋' }])

        // owner 해제: 수집 중단 + 후보 삭제 + 근거는 링크만 남음 + 설치 토큰 폐기.
        await expectServiceError(unlinkRepository(tx, { userId: editor.id }, project.id, { client: fake.client }), 'FORBIDDEN')
        await unlinkRepository(tx, { userId: owner.id }, project.id, { client: fake.client, now: at(4) })
        expect(fake.calls).toContain(`forget:${installationId}`)
        expect(await tx.select().from(githubItems).where(eq(githubItems.projectId, project.id))).toHaveLength(0)
        expect(await listGithubCandidates(tx, { userId: editor.id }, project.id)).toEqual({ linked: false, members: [] })
        const [after] = await listClaims(tx, { userId: editor.id }, project.id)
        expect(after!.evidence).toEqual([{ kind: 'github', itemId: null, itemKind: null, ref: null, url: editorItem.url, title: editorItem.title }])
        const [row] = await tx.select().from(claimEvidence).where(eq(claimEvidence.githubUrl, editorItem.url))
        expect(row?.githubItemId).toBeNull()
        expect(await receiveWebhook(tx, deps(fake), delivery('push', pushPayload(installationId, r, editorGithub, [{ message: 'later' }])), T0)).toEqual({ status: 'ignored' })
        // 해제는 다시 불러도 204(연결 없음).
        await unlinkRepository(tx, { userId: owner.id }, project.id, { client: fake.client })

        // 새 revision: 생략하면 링크만 남은 근거를 이어받고, 이전 주소로 명시해도 유지, 비우면 빠집니다.
        const revised = await reviseClaim(tx, { userId: editor.id }, claim.id, { expectedRevision: 1, text: '로그인·회원가입 API 담당' }, at(5))
        expect(revised.evidence).toMatchObject([{ kind: 'github', itemId: null, url: editorItem.url }])
        const kept = await reviseClaim(tx, { userId: editor.id }, claim.id, { expectedRevision: 2, text: '로그인 API 담당', evidence: [{ kind: 'github', url: editorItem.url }] }, at(6))
        expect(kept.evidence).toHaveLength(1)
        const cleared = await reviseClaim(tx, { userId: editor.id }, claim.id, { expectedRevision: 3, evidence: [] }, at(7))
        expect(cleared.evidence).toEqual([])
        // 연결이 끊긴 뒤에는 지운 후보 id로 다시 붙일 수 없습니다.
        expect(await fields([{ kind: 'github', id: editorItem.id }])).toEqual({ evidence: 'not_found' })
      })
    })

    it('study records and non-members cannot use GitHub integration', async () => {
      await withRollback(async (tx) => {
        const fake = fakeGithub()
        const { owner, project } = await team(tx, [])
        const stranger = await createUser(tx)
        await expectServiceError(getProjectGithub(tx, { userId: stranger.id }, project.id), 'NOT_FOUND')
        await expectServiceError(unlinkRepository(tx, { userId: stranger.id }, project.id, { client: fake.client }), 'NOT_FOUND')
        await expectServiceError(getProjectGithub(tx, { userId: owner.id }, 'not-a-uuid'), 'NOT_FOUND')
        const status = await getProjectGithub(tx, { userId: owner.id }, project.id)
        expect(status).toEqual({ link: null, pendingChoices: null, canManage: true, identityLinked: false })
      })
    })
  })
})
