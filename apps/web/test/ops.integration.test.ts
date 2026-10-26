/**
 * T-16 점검 모드·pilot 분석 이벤트(허용 목록·수집 거부)·운영자 지표(작은 수 가림)·상세 상태 확인 권한.
 * 점검 모드는 DB 없이 h3 앱으로, 나머지는 실제 PostgreSQL(rollback)로 봅니다. 이 테스트가 만든 사용자의 이벤트만 확인하고,
 * 지표는 다른 이벤트가 없는 먼 미래 기간으로 계산합니다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, defineEventHandler, toWebHandler } from 'h3'
import { ANALYTICS_EVENT_NAMES, ANALYTICS_PROP_SPECS, sanitizeAnalyticsProps } from '@peerchive/domain'
import { analyticsEvents, eq, hashSubject, operators, users, workerHeartbeats, type DbExecutor } from '@peerchive/db'
import { createFilesystemStorage } from '@peerchive/files'
import { analyticsPepper, emitAnalytics, setAnalyticsEnvForTesting, setAnalyticsOptOut } from '../server/modules/analytics/analytics'
import { saveMyCheckin } from '../server/modules/checkins/checkins'
import { createClaim, setEndorsement } from '../server/modules/contribution/claims'
import { recordReportExport } from '../server/modules/contribution/ledger'
import { getMe } from '../server/modules/identity/profiles'
import { createMemoryTransport } from '../server/modules/identity/mail'
import { requestMagicLink, verifyMagicLink } from '../server/modules/identity/magic-link'
import { createLog, reviseLog } from '../server/modules/logs/logs'
import { deepHealth, deepHealthAccess } from '../server/modules/ops/health'
import { createMaintenanceGate, isMaintenanceExempt, maintenanceEnabled } from '../server/modules/ops/maintenance'
import { getOperatorMetrics } from '../server/modules/ops/metrics'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, withRollback } from './helpers'

const SENTINEL = 'SENTINEL-비밀과제본문-leak@example.test-https://private.example/x'

describe('maintenance mode', () => {
  const build = (env: Record<string, string | undefined>) => {
    const app = createApp()
    app.use(createMaintenanceGate(() => env))
    app.use(defineEventHandler(() => ({ ok: true })))
    const handler = toWebHandler(app)
    return (p: string, method = 'GET') => handler(new Request(`http://localhost:3000${p}`, { method }))
  }

  it('returns 503 for everything except /api/v1/health when PEERCHIVE_MAINTENANCE is on', async () => {
    const call = build({ PEERCHIVE_MAINTENANCE: '1' })
    for (const p of ['/', '/projects', '/p/some-case', '/api/v1/me', '/api/v1/public/publications/x', '/api/internal/discord/logs', '/_nuxt/app.js', '/api/v1/healthz', '/api/v1/health/../me']) {
      const res = await call(p)
      expect(res.status, p).toBe(503)
      expect(res.headers.get('retry-after')).toBe('600')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(await (await call('/api/v1/projects', 'POST')).text()).toContain('maintenance')
    expect(await (await call('/')).text()).toContain('점검')
    expect((await call('/api/v1/health')).status).toBe(200)
    expect((await call('/api/v1/health?deep=1')).status).toBe(200)
  })

  it('passes everything through when off', async () => {
    for (const env of [{}, { PEERCHIVE_MAINTENANCE: '0' }, { PEERCHIVE_MAINTENANCE: '' }]) {
      expect((await build(env)('/projects')).status).toBe(200)
    }
    expect(maintenanceEnabled({ PEERCHIVE_MAINTENANCE: 'on' })).toBe(true)
    expect(isMaintenanceExempt('/api/v1/health?deep=1')).toBe(true)
    expect(isMaintenanceExempt('/api/v1/health/x')).toBe(false)
  })
})

describe('analytics emitters (static)', () => {
  /** server/modules 아래 모든 .ts 파일의 내용. */
  const sources = (() => {
    const root = path.resolve(__dirname, '../server/modules')
    const out: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith('.ts')) out.push(readFileSync(full, 'utf8'))
      }
    }
    walk(root)
    return out.join('\n')
  })()

  it('every event name has an emitter in the services, and no emitter passes a free-text field', () => {
    for (const name of ANALYTICS_EVENT_NAMES) expect(sources, name).toContain(`name: '${name}'`)
    // 허용 목록 밖의 키(제목·본문·메모·이메일·URL·파일 이름·검색어)는 어떤 이벤트에도 없습니다.
    for (const specs of Object.values(ANALYTICS_PROP_SPECS)) {
      for (const key of Object.keys(specs)) expect(['title', 'body', 'note', 'text', 'email', 'url', 'fileName', 'q', 'query', 'summary']).not.toContain(key)
    }
  })

  it('rejects sentinel strings for every event and key', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      for (const key of [...Object.keys(ANALYTICS_PROP_SPECS[name]), 'title', 'body']) {
        expect(sanitizeAnalyticsProps(name, { [key]: SENTINEL }).ok).toBe(false)
      }
    }
  })
})

describe.skipIf(!databaseUrl)('analytics, metrics and deep health (PostgreSQL)', () => {
  afterAll(async () => {
    setAnalyticsEnvForTesting(null)
    await closeTestDb()
  })

  const eventsOf = async (tx: DbExecutor, userId: string) =>
    tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(analyticsPepper()!, userId)))

  it('emits allowlisted, hashed events from real service flows and never stores content', async () => {
    await withRollback(async (tx) => {
      // 로그인(새 사용자)
      const mail = createMemoryTransport()
      const email = `analytics+${crypto.randomUUID()}@example.test`
      await requestMagicLink(tx, { email, ip: crypto.randomUUID(), mail, buildVerifyUrl: (t) => `http://localhost:3000/v?token=${t}` })
      const token = mail.messages.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]
      const login = await verifyMagicLink(tx, { token })
      expect(login.ok).toBe(true)
      const ownerId = login.ok ? login.userId : ''
      await tx.update(users).set({ displayName: '분석 소유자' }).where(eq(users.id, ownerId))
      const owner = { userId: ownerId }
      const mate = await createUser(tx, { displayName: '분석 팀원' })

      const project = await createProject(tx, owner, { title: SENTINEL, kind: 'team', summaryByStudent: SENTINEL, goal: SENTINEL })
      const { token: invite } = await createInvitation(tx, owner, project.id, { role: 'editor' })
      await acceptInvitation(tx, { userId: mate.id }, { token: invite })
      const created = await createLog(tx, owner, project.id, { tag: 'progress', body: SENTINEL, links: [{ url: 'https://private.example/x', title: SENTINEL }] })
      await reviseLog(tx, owner, created.log.id, { expectedRevision: 1, body: `${SENTINEL} 2` })
      await createLog(tx, owner, project.id, { tag: 'stuck', payload: { symptom: SENTINEL, timeBucket: 'lt2h' } })
      const claim = await createClaim(tx, { userId: mate.id }, project.id, { text: SENTINEL, evidence: [{ kind: 'log', id: created.log.id }] })
      await setEndorsement(tx, owner, claim.revisionId, { status: 'disputed', note: SENTINEL })
      await saveMyCheckin(tx, owner, project.id, { timeBucket: 'lt5h', difficulty: 4, note: SENTINEL, skipReasons: ['busy'] })
      await recordReportExport(tx, owner, project.id, {})

      const mine = await eventsOf(tx, ownerId)
      const names = mine.map((e) => e.name).sort()
      expect(names).toEqual(
        ['checkin_submitted', 'claim_endorsed', 'evidence_attached', 'log_saved', 'log_saved', 'log_saved', 'login_succeeded', 'project_created', 'report_exported'].sort(),
      )
      expect(mine.find((e) => e.name === 'login_succeeded')!.props).toEqual({ newUser: true })
      expect(mine.find((e) => e.name === 'project_created')!.props).toEqual({ kind: 'team', origin: 'web', retro: false, withCourse: false })
      expect(mine.find((e) => e.name === 'evidence_attached')!.props).toEqual({ files: 0, links: 1, target: 'log' })
      expect(mine.find((e) => e.name === 'claim_endorsed')!.props).toEqual({ status: 'disputed' })
      expect(mine.find((e) => e.name === 'checkin_submitted')!.props).toMatchObject({ difficulty: 4, timeBucket: 'lt5h', skipReasons: 1 })
      const mateEvents = await eventsOf(tx, mate.id)
      expect(mateEvents.map((e) => e.name)).toEqual(['evidence_attached'])
      expect(mateEvents[0]!.props).toEqual({ files: 0, logs: 1, target: 'claim' })

      const all = [...mine, ...mateEvents]
      for (const e of all) {
        expect(sanitizeAnalyticsProps(e.name, e.props).ok, e.name).toBe(true)
        expect(e.actorHash).toMatch(/^[0-9a-f]{64}$/)
        const stored = JSON.stringify(e)
        for (const secret of ['SENTINEL', 'private.example', email, ownerId, mate.id, project.id]) expect(stored).not.toContain(secret)
      }
      expect(mine.filter((e) => e.projectHash).every((e) => e.projectHash === hashSubject(analyticsPepper()!, project.id))).toBe(true)
    })
  })

  it('opt-out stops new events and deletes past ones; missing pepper in production disables analytics', async () => {
    await withRollback(async (tx) => {
      const user = await createUser(tx)
      const actor = { userId: user.id }
      await createProject(tx, actor, { title: '하나' })
      expect(await eventsOf(tx, user.id)).toHaveLength(1)
      expect(await setAnalyticsOptOut(tx, actor, { analyticsOptOut: true })).toEqual({ analyticsOptOut: true, deletedEvents: 1 })
      expect((await getMe(tx, actor)).analyticsOptOut).toBe(true)
      await createProject(tx, actor, { title: '둘' })
      expect(await eventsOf(tx, user.id)).toHaveLength(0)
      await expectServiceError(setAnalyticsOptOut(tx, actor, { analyticsOptOut: 'yes' }), 'VALIDATION')
      await setAnalyticsOptOut(tx, actor, { analyticsOptOut: false })
      await createProject(tx, actor, { title: '셋' })
      expect(await eventsOf(tx, user.id)).toHaveLength(1)

      setAnalyticsEnvForTesting({ NODE_ENV: 'production' })
      try {
        expect(analyticsPepper()).toBeNull()
        expect(await emitAnalytics(tx, { name: 'project_created', actorId: user.id })).toBe(false)
      } finally {
        setAnalyticsEnvForTesting(null)
      }
      // 허용 목록 위반은 이벤트 전체를 버립니다.
      expect(await emitAnalytics(tx, { name: 'log_saved', actorId: user.id, props: { tag: 'progress', body: SENTINEL } })).toBe(false)
      expect(await eventsOf(tx, user.id)).toHaveLength(1)
    })
  })

  it('operator metrics are operator-only and suppress numbers under 5', async () => {
    await withRollback(async (tx) => {
      const operator = await createUser(tx)
      await tx.insert(operators).values({ userId: operator.id })
      const someone = await createUser(tx)
      await expectServiceError(getOperatorMetrics(tx, { userId: someone.id }, {}), 'FORBIDDEN', 'operator_only')

      // 다른 이벤트가 없는 먼 미래 기간.
      const day = (d: number) => new Date(Date.UTC(2091, 0, 1 + d, 3))
      const pepper = analyticsPepper()!
      const rows = []
      for (let a = 0; a < 6; a++) {
        const actorHash = hashSubject(pepper, crypto.randomUUID())
        const projectHash = hashSubject(pepper, crypto.randomUUID())
        rows.push({ name: 'login_succeeded' as const, actorHash, hashKeyId: '00000000', occurredAt: day(0), props: { newUser: true } })
        rows.push({ name: 'project_created' as const, actorHash, projectHash, hashKeyId: '00000000', occurredAt: day(1), props: {} })
        for (let i = 0; i < 3; i++) rows.push({ name: 'log_saved' as const, actorHash, projectHash, hashKeyId: '00000000', occurredAt: day(2), props: { revision: false } })
        if (a < 5) rows.push({ name: 'evidence_attached' as const, actorHash, projectHash, hashKeyId: '00000000', occurredAt: day(3), props: {} })
        if (a < 3) rows.push({ name: 'plan_forked' as const, actorHash, hashKeyId: '00000000', occurredAt: day(4), props: {} })
      }
      await tx.insert(analyticsEvents).values(rows)
      const m = await getOperatorMetrics(tx, { userId: operator.id }, { from: '2091-01-01', to: '2091-01-20' }, new Date(Date.UTC(2091, 1, 1)))
      expect(m.activation).toEqual({ denominator: 6, numerator: 5, rate: 0.833 })
      expect(m.northStar.planForks).toBeNull()
      expect(m.eventCounts.log_saved).toBe(18)
      expect(m.eventCounts.plan_forked).toBeNull()
      expect(m.writeTimeMedianMinutes).toBeNull()
      await expectServiceError(getOperatorMetrics(tx, { userId: operator.id }, { from: '2091-02-01', to: '2091-01-01' }), 'VALIDATION')
      await expectServiceError(getOperatorMetrics(tx, { userId: operator.id }, { from: '2089-01-01', to: '2091-01-01' }), 'VALIDATION')
    })
  })

  it('deep health requires an operator and reports db, storage probe, worker heartbeat, outbox and overdue deletions', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'peerchive-health-'))
    try {
      await withRollback(async (tx) => {
        const operator = await createUser(tx)
        const someone = await createUser(tx)
        await tx.insert(operators).values({ userId: operator.id })
        expect(await deepHealthAccess(tx, null)).toBe(401)
        expect(await deepHealthAccess(tx, someone.id)).toBe(403)
        expect(await deepHealthAccess(tx, operator.id)).toBe('ok')

        const storage = createFilesystemStorage(root)
        const now = new Date()
        const flags = { maintenance: false, publicReadsDisabled: false }
        await tx.delete(workerHeartbeats).where(eq(workerHeartbeats.name, 'worker'))
        const missing = await deepHealth({ db: tx, storage, now, graceDays: 7, flags })
        expect(missing).toMatchObject({ status: 'degraded', db: { status: 'ok' }, storage: { status: 'ok', driver: 'filesystem' }, worker: { status: 'missing' } })
        await tx.insert(workerHeartbeats).values({ name: 'worker', beatAt: now, details: {} })
        const ok = await deepHealth({ db: tx, storage, now, graceDays: 7, flags })
        expect(ok.worker.status).toBe('ok')
        expect(ok.outbox.backlog).toBeGreaterThanOrEqual(0)
        const stale = await deepHealth({ db: tx, storage, now: new Date(now.getTime() + 10 * 60_000), graceDays: 7, flags })
        expect(stale.worker.status).toBe('stale')
        // 유예 + 하루가 지났는데 정리되지 않은 탈퇴 계정은 늦은 삭제로 셉니다.
        const before = ok.deletion.overdue
        const gone = await createUser(tx, { status: 'deleted' })
        await tx.update(users).set({ deletionRequestedAt: new Date('2000-01-01T00:00:00Z') }).where(eq(users.id, gone.id))
        expect((await deepHealth({ db: tx, storage, now, graceDays: 7, flags })).deletion.overdue).toBe(before + 1)
        // 저장소 시험은 흔적을 남기지 않습니다.
        const left: string[] = []
        for await (const item of storage.list('quarantine')) left.push(item.key)
        expect(left).toEqual([])
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
