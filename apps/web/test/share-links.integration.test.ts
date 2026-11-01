/**
 * E-07 제한 공유 링크 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * - 토큰은 256비트 base64url, DB·감사에는 SHA-256 해시만(원문·이름 글 없음). 만료 1~90일, 철회·만료·새 판·프로필 숨김 → 다음 요청부터 404.
 * - 공유 API는 늘 noindex·no-referrer·no-store·쿠키 없음, 열면 열람 횟수만 1 올림, IP마다 한도(429). robots.txt는 `/s/`·공유 API를 늘 막음.
 * - 공개 범위를 넓히지 않음: 게시 취소·숨김·철회·엠바고한 케이스는 글 없이 안내만, 공개 프로필에 있는 과제 수행 목록·타임라인·소셜 링크 등은 없음.
 * - S-01: 표시명 판 링크에 실명 정보 없음, 실명 판 링크에 표시명 정보 없음(연결 플래그를 켜도 공유 DTO에는 상대 페르소나가 없음).
 * 탈퇴 정리는 apps/worker ops-purge.test.ts, 브라우저 흐름(만들기 → 익명으로 열기 → 철회 → 404)은 apps/e2e e07-share-links.spec.ts.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import { auditEvents, caseStudies, eq, personas, portfolioShareLinks, profiles, users, type DbExecutor } from '@peerchive/db'
import { createLog } from '../server/modules/logs/logs'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { createCaseStudy, publishCaseStudy, unpublishCaseStudy } from '../server/modules/portfolio/case-studies'
import { createEdition } from '../server/modules/portfolio/editions'
import { createSharedPortfolioHandler } from '../server/modules/portfolio/public-http'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import {
  SHARE_LINK_ACTIVE_LIMIT,
  SHARE_LINK_VIEW_RATE_LIMIT,
  createShareLink,
  deleteShareLink,
  getSharedPortfolio,
  listMyShareLinks,
  revokeShareLink,
} from '../server/modules/portfolio/share-links'
import { isPublicPagePath } from '../server/modules/publication/public-http'
import { robotsTxt } from '../server/modules/security/robots'
import { sha256Hex } from '../server/modules/security/tokens'
import { createDisplayPersona, setIdentityLink } from '../server/modules/social/personas'
import { setProjectListing, setVisibility } from '../server/modules/social/visibility'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, withRollback } from './helpers'
import type { SharedPortfolioDto } from '../shared/types/api'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const tag = () => crypto.randomUUID().slice(0, 8)

/** 개인 과제 하나를 이름으로 공개·게시하고, 그 케이스를 대표로 둔 실명 판을 만듭니다. */
async function featured(db: DbExecutor) {
  const handle = `sl-${tag()}`
  const owner = await createUser(db, { displayName: '김공유', handle })
  const A = { userId: owner.id }
  const project = await createProject(db, A, { title: `공유 과제 PROJECTSENTINEL${tag()}`, kind: 'individual' }, T0)
  const decision = (
    await createLog(db, A, project.id, { tag: 'decision', payload: { options: ['A안', 'B안'], criteria: '비용', choice: 'B안' } }, at(1))
  ).log
  const slug = `sl-${tag()}`
  const candidate = await createCandidate(
    db,
    A,
    project.id,
    { level: 'summary', title: '공유용 사례 CASESENTINEL', summary: 'B안을 골랐다.', slug, logIds: [decision.id], exposure: { [owner.id]: 'name' }, consentSelf: true },
    at(2),
    ORIGINS,
  )
  const published = await publishCandidate(db, A, candidate.id, { manifestHash: candidate.manifestHash }, at(3))
  const draft = await createCaseStudy(db, A, { releaseSlug: slug, jobTarget: 'backend' }, at(4))
  const cs = await publishCaseStudy(db, A, draft.id, { expectedVersion: draft.version, confirmWarnings: true }, at(5))
  const edition = await createEdition(db, A, { featuredCaseStudyIds: [cs.id], headline: '공유 판 한 줄', skillsDeclared: ['SQL'] }, at(6))
  const [real] = await db.select().from(personas).where(eq(personas.handle, handle))
  return { owner, A, handle, realId: real!.id, project, slug, cs, edition, publication: published.publication }
}

function web(db: DbExecutor, now: Date, clientKey: () => string | null = () => null) {
  const app = createApp()
  app.use(createRouter().get('/api/v1/public/share/:token', createSharedPortfolioHandler({ getDb: () => db, now: () => now, getEnv: () => ({ PEERCHIVE_PUBLIC_INDEXING: '1' }), clientKey })))
  const handler = toWebHandler(app)
  return (token: string) => handler(new Request(`http://localhost:3000/api/v1/public/share/${token}`, { headers: { cookie: 'peerchive_session=abc' } }))
}

const viewCount = async (db: DbExecutor, id: string) => (await db.select().from(portfolioShareLinks).where(eq(portfolioShareLinks.id, id)))[0]!.viewCount

describe.skipIf(!databaseUrl)('share links (E-07, PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('stores only the token hash, validates expiry and label, and lets only the owner manage links', async () => {
    await withRollback(async (tx) => {
      const f = await featured(tx)
      const label = `LABELSENTINEL${tag()}`
      const link = await createShareLink(tx, f.A, f.edition.id, { label: `  ${label}  ` }, at(10))
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(link.path).toBe(`/s/${link.token}`)
      expect(link).toMatchObject({ label, status: 'active', viewCount: 0, revokedAt: null, edition: { id: f.edition.id, version: 1, personaKind: 'real', personaHandle: f.handle } })
      expect(new Date(link.expiresAt).getTime() - at(10).getTime()).toBe(days(30))
      const [row] = await tx.select().from(portfolioShareLinks).where(eq(portfolioShareLinks.id, link.id))
      expect(row!.tokenHash).toBe(sha256Hex(link.token))
      expect(JSON.stringify(row)).not.toContain(link.token)
      // 목록에는 토큰이 다시 나오지 않습니다.
      const listed = await listMyShareLinks(tx, f.A, at(10))
      expect(listed).toHaveLength(1)
      expect(JSON.stringify(listed)).not.toContain(link.token)
      // 감사: id·플래그만(토큰·해시·이름 글 없음).
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, link.id))
      expect(audits.map((a) => a.action)).toEqual(['share_link.create'])
      expect(audits[0]!.metadata).toEqual({ editionId: f.edition.id, personaKind: 'real', expiresInDays: 30, labeled: true })
      const auditText = JSON.stringify(audits)
      for (const secret of [link.token, row!.tokenHash, label]) expect(auditText).not.toContain(secret)

      const max = await createShareLink(tx, f.A, f.edition.id, { expiresInDays: 90 }, at(10))
      expect(new Date(max.expiresAt).getTime() - at(10).getTime()).toBe(days(90))
      for (const [input, fields] of [
        [{ expiresInDays: 91 }, { expiresInDays: 'too_large' }],
        [{ expiresInDays: 0 }, { expiresInDays: 'too_small' }],
        [{ expiresInDays: 1.5 }, { expiresInDays: 'invalid' }],
        [{ label: '가'.repeat(61) }, { label: 'too_long' }],
      ] as const) {
        await expectServiceError(createShareLink(tx, f.A, f.edition.id, input, at(10)), 'VALIDATION').then((e) => expect(e.fields).toEqual(fields))
      }

      // 다른 사람은 내 판에 링크를 만들거나 내 링크를 철회·지울 수 없습니다(존재를 드러내지 않는 404).
      const other = { userId: (await createUser(tx, { handle: `sl-${tag()}` })).id }
      await expectServiceError(createShareLink(tx, other, f.edition.id, {}, at(10)), 'NOT_FOUND')
      await expectServiceError(revokeShareLink(tx, other, link.id, at(10)), 'NOT_FOUND')
      await expectServiceError(deleteShareLink(tx, other, link.id, at(10)), 'NOT_FOUND')
      await expectServiceError(createShareLink(tx, f.A, 'nope', {}, at(10)), 'NOT_FOUND')
      expect(await listMyShareLinks(tx, other, at(10))).toEqual([])

      // 열린 링크 한도.
      for (let i = 2; i < SHARE_LINK_ACTIVE_LIMIT; i++) await createShareLink(tx, f.A, f.edition.id, {}, at(10))
      await expectServiceError(createShareLink(tx, f.A, f.edition.id, {}, at(10)), 'CONFLICT').then((e) => expect(e.reason).toBe('limit_reached'))
      await revokeShareLink(tx, f.A, max.id, at(11))
      await createShareLink(tx, f.A, f.edition.id, {}, at(11))
    })
  })

  it('serves the edition with noindex and no-referrer headers, counts views only, and 404s from the next request after revoke', async () => {
    await withRollback(async (tx) => {
      const f = await featured(tx)
      const link = await createShareLink(tx, f.A, f.edition.id, {}, at(10))
      const get = web(tx, at(11))
      const res = await get(link.token)
      expect(res.status).toBe(200)
      // 공개 색인을 켜도 공유 응답은 늘 noindex입니다.
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('set-cookie')).toBeNull()
      const body = (await res.json()) as SharedPortfolioDto
      expect(body).toMatchObject({ handle: f.handle, displayName: '김공유', kind: 'real', headline: '공유 판 한 줄', skillsDeclared: ['SQL'], edition: { version: 1 } })
      expect(body.featured[0]).toMatchObject({ available: true, title: f.cs.title, path: `/p/${f.slug}` })
      expect(await viewCount(tx, link.id)).toBe(1)
      await get(link.token)
      expect(await viewCount(tx, link.id)).toBe(2)
      expect((await listMyShareLinks(tx, f.A, at(11)))[0]!.viewCount).toBe(2)

      // 형식이 틀리거나 없는 토큰은 열람 수를 건드리지 않고 404.
      for (const bad of ['short', `${link.token.slice(0, -1)}A`, 'x'.repeat(200)]) {
        const r = await get(bad)
        expect(r.status, bad).toBe(404)
        expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      }
      expect(await viewCount(tx, link.id)).toBe(2)

      // 열린 링크는 지울 수 없고, 철회하면 다음 요청부터 404, 철회는 다시 해도 그대로입니다.
      await expectServiceError(deleteShareLink(tx, f.A, link.id, at(12)), 'CONFLICT').then((e) => expect(e.reason).toBe('share_link_active'))
      const revoked = await revokeShareLink(tx, f.A, link.id, at(12))
      expect(revoked).toMatchObject({ status: 'revoked', revokedAt: at(12).toISOString(), viewCount: 2 })
      const after = await web(tx, at(12))(link.token)
      expect(after.status).toBe(404)
      expect(after.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(await viewCount(tx, link.id)).toBe(2)
      expect((await revokeShareLink(tx, f.A, link.id, at(13))).revokedAt).toBe(at(12).toISOString())
      expect((await tx.select().from(auditEvents).where(eq(auditEvents.targetId, link.id))).map((a) => a.action).sort()).toEqual(['share_link.create', 'share_link.revoke'])
      await deleteShareLink(tx, f.A, link.id, at(13))
      expect(await listMyShareLinks(tx, f.A, at(13))).toEqual([])
    })
  })

  it('expires, closes when the edition is superseded, the profile is hidden or the account is not active', async () => {
    await withRollback(async (tx) => {
      const f = await featured(tx)
      const short = await createShareLink(tx, f.A, f.edition.id, { expiresInDays: 1 }, at(10))
      expect((await getSharedPortfolio(tx, short.token, new Date(at(10).getTime() + days(1) - 1))).handle).toBe(f.handle)
      await expectServiceError(getSharedPortfolio(tx, short.token, new Date(at(10).getTime() + days(1))), 'NOT_FOUND')
      expect((await listMyShareLinks(tx, f.A, new Date(at(10).getTime() + days(1))))[0]!.status).toBe('expired')

      const link = await createShareLink(tx, f.A, f.edition.id, {}, at(10))
      await tx.update(profiles).set({ hiddenAt: at(11) }).where(eq(profiles.personaId, f.realId))
      await expectServiceError(getSharedPortfolio(tx, link.token, at(11)), 'NOT_FOUND')
      await tx.update(profiles).set({ hiddenAt: null }).where(eq(profiles.personaId, f.realId))
      await tx.update(users).set({ status: 'suspended' }).where(eq(users.id, f.owner.id))
      await expectServiceError(getSharedPortfolio(tx, link.token, at(11)), 'NOT_FOUND')
      await tx.update(users).set({ status: 'active' }).where(eq(users.id, f.owner.id))
      await getSharedPortfolio(tx, link.token, at(11))

      // 새 판을 만들면 이전 판(공개하지 않음)의 링크는 열리지 않고, 이전 판에는 새 링크를 만들 수 없습니다.
      const next = await createEdition(tx, f.A, { featuredCaseStudyIds: [f.cs.id], headline: '새 판' }, at(12))
      await expectServiceError(getSharedPortfolio(tx, link.token, at(12)), 'NOT_FOUND')
      expect((await listMyShareLinks(tx, f.A, at(12))).find((l) => l.id === link.id)!.status).toBe('superseded')
      await expectServiceError(createShareLink(tx, f.A, f.edition.id, {}, at(12)), 'CONFLICT').then((e) => expect(e.reason).toBe('edition_superseded'))
      const fresh = await createShareLink(tx, f.A, next.id, {}, at(12))
      expect((await getSharedPortfolio(tx, fresh.token, at(12))).headline).toBe('새 판')
      // 지난 판 링크는 철회 없이 지울 수 있습니다.
      await deleteShareLink(tx, f.A, link.id, at(12))
    })
  })

  it('never widens visibility: closed cases show no text and profile-only items are absent', async () => {
    await withRollback(async (tx) => {
      const f = await featured(tx)
      // 공개 프로필에는 과제 수행 목록(전체 공개)이 있지만 공유 DTO에는 없습니다.
      await setVisibility(tx, f.A, f.realId, { items: { project_list: 'public' } }, at(7))
      await setProjectListing(tx, f.A, f.realId, { projectId: f.project.id, shown: true }, at(7))
      const profile = await getPublicPortfolioProfile(tx, f.handle, at(8))
      expect(JSON.stringify(profile.projects)).toContain('PROJECTSENTINEL')
      expect(profile.timeline).toHaveLength(1)
      const link = await createShareLink(tx, f.A, f.edition.id, {}, at(10))
      const shared = await getSharedPortfolio(tx, link.token, at(10))
      for (const key of ['projects', 'timeline', 'juniorContribution', 'socialLinks', 'affiliationBadges', 'linkedPersona', 'followCounts', 'contactPolicy']) {
        expect(shared, key).not.toHaveProperty(key)
      }
      expect(JSON.stringify(shared)).not.toContain('PROJECTSENTINEL')
      expect(JSON.stringify(shared)).not.toContain(link.token)

      const closedText = async (now: Date) => {
        const s = await getSharedPortfolio(tx, link.token, now)
        expect(s.featured[0]!.available).toBe(false)
        expect(JSON.stringify(s)).not.toContain('CASESENTINEL')
        expect(JSON.stringify(s)).not.toContain(f.cs.title)
      }
      // 게시 취소 → 닫힘, 다시 게시 → 열림.
      const off = await unpublishCaseStudy(tx, f.A, f.cs.id, at(11))
      await closedText(at(11))
      await publishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: off.version, confirmWarnings: true }, at(12))
      expect((await getSharedPortfolio(tx, link.token, at(12))).featured[0]!.available).toBe(true)
      // 운영 조치 숨김.
      await tx.update(caseStudies).set({ hiddenAt: at(13) }).where(eq(caseStudies.id, f.cs.id))
      await closedText(at(13))
      await tx.update(caseStudies).set({ hiddenAt: null }).where(eq(caseStudies.id, f.cs.id))
      // 엠바고 → 닫힘(공개 프로필과 같은 판정).
      await addProjectEmbargo(tx, f.A, f.project.id, { until: '2027-06-01T00:00:00Z', reason: '재수강' }, at(14))
      await closedText(at(15))
      expect((await getPublicPortfolioProfile(tx, f.handle, at(15))).featured[0]!.available).toBe(false)
    })
  })

  it('closes cases when the source publication is withdrawn', async () => {
    await withRollback(async (tx) => {
      const f = await featured(tx)
      const link = await createShareLink(tx, f.A, f.edition.id, {}, at(10))
      await withdrawPublication(tx, f.A, f.publication.id, {}, at(11))
      const s = await getSharedPortfolio(tx, link.token, at(12))
      expect(s.featured[0]).toMatchObject({ available: false })
      expect(JSON.stringify(s)).not.toContain('CASESENTINEL')
    })
  })

  it('keeps the S-01 identity link rule: a share page never reveals the other persona', async () => {
    await withRollback(async (tx) => {
      const f = await featured(tx)
      const displayHandle = `sld-${tag()}`
      const displayName = `밤공유${tag()}`
      const display = await createDisplayPersona(tx, f.A, { handle: displayHandle, displayName }, at(7))
      const displayEdition = await createEdition(tx, f.A, { personaId: display.id, headline: '표시명 판 글' }, at(8))
      const realLink = await createShareLink(tx, f.A, f.edition.id, {}, at(10))
      const displayLink = await createShareLink(tx, f.A, displayEdition.id, {}, at(10))
      expect(displayLink.edition).toMatchObject({ personaKind: 'display', personaHandle: displayHandle })
      for (const visible of [false, true]) {
        await setIdentityLink(tx, f.A, { visible }, at(11))
        const real = JSON.stringify(await getSharedPortfolio(tx, realLink.token, at(11)))
        expect(real).toContain(f.handle)
        for (const secret of [displayHandle, displayName, '표시명 판 글']) expect(real, `visible=${visible}`).not.toContain(secret)
        const shown = await getSharedPortfolio(tx, displayLink.token, at(11))
        expect(shown).toMatchObject({ kind: 'display', handle: displayHandle, displayName, featured: [], headline: '표시명 판 글' })
        const text = JSON.stringify(shown)
        for (const secret of [f.handle, '김공유', 'CASESENTINEL', f.slug, '공유 판 한 줄']) expect(text, `visible=${visible}`).not.toContain(secret)
      }
    })
  })

  it('rate limits views per client key and blocks share paths in robots.txt', async () => {
    await withRollback(async (tx) => {
      const f = await featured(tx)
      const link = await createShareLink(tx, f.A, f.edition.id, {}, at(10))
      const ip = `198.51.100.${Math.floor(Math.random() * 200)}-${tag()}`
      const get = web(tx, at(11), () => ip)
      for (let i = 0; i < SHARE_LINK_VIEW_RATE_LIMIT.limit; i++) expect((await get(link.token)).status).toBe(200)
      const limited = await get(link.token)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(await viewCount(tx, link.id)).toBe(SHARE_LINK_VIEW_RATE_LIMIT.limit)
      // 같은 프로세스 SSR 요청(키 없음)은 바깥 페이지 요청이 센 것으로 갈음합니다.
      expect((await web(tx, at(11), () => null)(link.token)).status).toBe(200)
    })
    for (const env of [{}, { PEERCHIVE_PUBLIC_INDEXING: '1' }]) {
      const txt = robotsTxt(env)
      if (env.PEERCHIVE_PUBLIC_INDEXING) {
        expect(txt).toContain('Disallow: /s/\n')
        expect(txt).toContain('Disallow: /api/v1/public/share/\n')
      } else expect(txt).toContain('Disallow: /\n')
    }
    // 공유 페이지는 공개 페이지라 SSR이 보는 사람의 로그인 상태를 싣지 않습니다.
    expect(isPublicPagePath('/s/abc')).toBe(true)
    expect(isPublicPagePath('/settings')).toBe(false)
  })
})
