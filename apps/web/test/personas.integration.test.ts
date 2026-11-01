/**
 * S-01 페르소나·표시명 ↔ 실명 연결 플래그 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * DELIVERY_PLAN §5.2 시나리오 R: 연결이 꺼져 있으면 두 공개 프로필의 JSON·README 카드(그리고 이 JSON만 그리는 HTML·OG·인쇄 보기 — 브라우저 쪽은
 * apps/e2e r-personas.spec.ts)에 상대 페르소나의 handle·이름·id·소개가 0건, 켜면 서로의 링크, 다시 끄면 다음 요청부터 사라짐.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import { and, auditEvents, eq, identityLinks, personas, profiles, sql, type DbExecutor } from '@peerchive/db'
import { getMe, getPublicProfile, upsertProfile } from '../server/modules/identity/profiles'
import { createEdition, listMyEditions } from '../server/modules/portfolio/editions'
import { createPublicProfileHandler, createReadmeCardHandler } from '../server/modules/portfolio/public-http'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { listMembers } from '../server/modules/projects/members'
import { createProject } from '../server/modules/projects/projects'
import { createDisplayPersona, listMyPersonas, setIdentityLink, updatePersona } from '../server/modules/social/personas'
import { closeTestDb, createUser, databaseUrl, expectServiceError, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const tag = () => crypto.randomUUID().slice(0, 8)

/** 실명 페르소나(온보딩) + 표시명 페르소나 하나를 가진 사용자. 두 쪽 모두 고유한 이름·소개를 둬서 새는지 문자열로 찾습니다. */
async function twoPersonas(db: DbExecutor) {
  const t = tag()
  const real = { handle: `real-${t}`, name: `김실명${t}`, headline: `실명 소개 ${t} REALHEAD` }
  const display = { handle: `night-${t}`, name: `밤의개발자${t}`, headline: `표시명 소개 ${t} DISPHEAD` }
  const user = await createUser(db, { displayName: '임시' })
  const A = { userId: user.id }
  await upsertProfile(db, A, { handle: real.handle, displayName: real.name, headline: real.headline })
  const created = await createDisplayPersona(db, A, { handle: display.handle, displayName: display.name, headline: display.headline }, T0)
  const mine = await listMyPersonas(db, A)
  const realId = mine.personas.find((p) => p.kind === 'real')!.id
  return { user, A, real: { ...real, id: realId }, display: { ...display, id: created.id } }
}

type Side = { handle: string; name: string; headline: string; id: string }

/** 공개 경로 전부(공개 프로필 JSON·README 카드 HTTP, 이전 공개 프로필 DTO)의 본문. */
async function publicBodies(db: DbExecutor, handle: string): Promise<string> {
  const deps = { getDb: () => db, now: () => T0, getEnv: () => ({}) }
  const app = createApp()
  app.use(
    createRouter()
      .get('/api/v1/public/profiles/:handle', createPublicProfileHandler(deps))
      .get('/api/v1/public/profiles/:handle/readme-card.md', createReadmeCardHandler({ ...deps, getOrigin: () => 'https://peerchive.test' })),
  )
  const web = toWebHandler(app)
  const get = async (path: string) => {
    const res = await web(new Request(`http://localhost:3000${path}`))
    expect(res.status, path).toBe(200)
    return res.text()
  }
  return [
    await get(`/api/v1/public/profiles/${handle}`),
    await get(`/api/v1/public/profiles/${handle}/readme-card.md`),
    JSON.stringify(await getPublicProfile(db, handle)),
  ].join('\n')
}

function expectNothingOf(body: string, other: Side, label: string) {
  for (const value of [other.handle, other.name, other.id, other.headline]) expect(body, `${label}: ${value.slice(0, 6)}…`).not.toContain(value)
}

describe.skipIf(!databaseUrl)('S-01 personas (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('R: with the link off neither public profile carries anything of the other persona; on shows both links; off removes them again', async () => {
    await withRollback(async (tx) => {
      const f = await twoPersonas(tx)

      // 기본은 꺼짐(만들 때 visible = false).
      expect((await listMyPersonas(tx, f.A)).identityLink).toMatchObject({ visible: false })
      for (const [self, other] of [[f.real, f.display], [f.display, f.real]] as const) {
        const body = await publicBodies(tx, self.handle)
        expect(body).toContain(self.handle)
        expect(body).toContain(self.name)
        expectNothingOf(body, other, `off ${self.handle}`)
        // 자기 페르소나 id도 공개 DTO에 없음.
        expect(body).not.toContain(self.id)
        expect(body).not.toContain(f.user.id)
        const dto = await getPublicPortfolioProfile(tx, self.handle, T0)
        expect(dto.linkedPersona).toBeNull()
      }
      expect((await getPublicPortfolioProfile(tx, f.display.handle, T0)).kind).toBe('display')
      expect((await getPublicPortfolioProfile(tx, f.display.handle, T0)).displayName).toBe(f.display.name)

      // 켜기 → 양쪽에 서로의 링크(handle·이름). id는 여전히 없음.
      await setIdentityLink(tx, f.A, { visible: true }, T0)
      const onReal = await getPublicPortfolioProfile(tx, f.real.handle, T0)
      expect(onReal.linkedPersona).toEqual({ kind: 'display', handle: f.display.handle, displayName: f.display.name })
      const onDisplay = await getPublicPortfolioProfile(tx, f.display.handle, T0)
      expect(onDisplay.linkedPersona).toEqual({ kind: 'real', handle: f.real.handle, displayName: f.real.name })
      for (const [self, other] of [[f.real, f.display], [f.display, f.real]] as const) {
        const body = await publicBodies(tx, self.handle)
        expect(body).toContain(other.handle)
        expect(body).toContain(`https://peerchive.test/u/${other.handle}`)
        expect(body).not.toContain(other.id)
        // 연결은 링크만: 상대의 소개는 싣지 않음.
        expect(body).not.toContain(other.headline)
      }

      // 다시 끄기 → 다음 요청부터 0건.
      await setIdentityLink(tx, f.A, { visible: false }, T0)
      for (const [self, other] of [[f.real, f.display], [f.display, f.real]] as const) {
        expectNothingOf(await publicBodies(tx, self.handle), other, `off again ${self.handle}`)
      }

      // 감사: 토글마다 하나, 플래그만(handle·이름·페르소나 id 없음).
      const audits = await tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.actorId, f.user.id), sql`${auditEvents.action} like 'persona.%'`))
      const toggles = audits.filter((a) => a.action === 'persona.identity_link_update')
      expect(toggles.map((a) => a.metadata)).toEqual([{ visible: true }, { visible: false }])
      const metadata = JSON.stringify(audits.map((a) => a.metadata))
      for (const value of [f.real.handle, f.real.name, f.display.handle, f.display.name, f.real.id]) expect(metadata).not.toContain(value)
      // 바뀌지 않는 토글은 기록하지 않음.
      await setIdentityLink(tx, f.A, { visible: false }, T0)
      expect((await tx.select().from(auditEvents).where(and(eq(auditEvents.actorId, f.user.id), eq(auditEvents.action, 'persona.identity_link_update')))).length).toBe(2)
    })
  })

  it('persona rows and the display profile row never carry the other persona id; internal joins keep the real persona', async () => {
    await withRollback(async (tx) => {
      const f = await twoPersonas(tx)
      const [displayRow] = await tx.select().from(personas).where(eq(personas.id, f.display.id))
      expect(Object.values(displayRow!)).not.toContain(f.real.id)
      const [displayProfile] = await tx.select().from(profiles).where(eq(profiles.personaId, f.display.id))
      expect(displayProfile).toMatchObject({ personaKind: 'display', userId: null, handle: f.display.handle, headline: f.display.headline })
      // 내 정보·과제 공간 멤버 목록은 실명 페르소나 handle 그대로(표시명이 끼어들지 않음).
      expect((await getMe(tx, f.A)).profile?.handle).toBe(f.real.handle)
      // 부분 수정은 보낸 필드만 바꿈(보내지 않은 한 줄 소개를 지우지 않음).
      await upsertProfile(tx, f.A, { showAffiliationBadge: true })
      expect((await getMe(tx, f.A)).profile).toMatchObject({ headline: f.real.headline, showAffiliationBadge: true })
      await updatePersona(tx, f.A, f.display.id, { openToWork: true })
      expect((await listMyPersonas(tx, f.A)).personas.find((p) => p.kind === 'display')?.profile).toMatchObject({ headline: f.display.headline, openToWork: true })
      const project = await createProject(tx, f.A, { title: '팀 과제', kind: 'team' }, T0)
      const members = await listMembers(tx, f.A, project.id)
      expect(JSON.stringify(members)).toContain(f.real.handle)
      expectNothingOf(JSON.stringify(members), f.display, 'members')
    })
  })

  it('handles: one global namespace across kinds, reserved words rejected, at most one display persona, real persona required first', async () => {
    await withRollback(async (tx) => {
      const f = await twoPersonas(tx)
      const other = await createUser(tx, { displayName: '다른 사람' })
      const B = { userId: other.id }
      // 실명 프로필이 없으면 표시명 페르소나를 만들 수 없음.
      await expectServiceError(createDisplayPersona(tx, B, { handle: `x-${tag()}`, displayName: '표시' }), 'CONFLICT', 'real_persona_required')
      // 남의 표시명 handle로 실명 프로필을 만들 수 없음(종류를 넘어 유일).
      const taken = await expectServiceError(upsertProfile(tx, B, { handle: f.display.handle, displayName: '다른 사람' }), 'VALIDATION')
      expect(taken.fields).toEqual({ handle: 'taken' })
      const bHandle = `b-${tag()}`
      await upsertProfile(tx, B, { handle: bHandle, displayName: '다른 사람' })
      // 남의 실명 handle로 표시명을 만들 수 없음. 자기 실명 handle도 안 됨.
      for (const handle of [f.real.handle, bHandle]) {
        const e = await expectServiceError(createDisplayPersona(tx, B, { handle, displayName: '표시' }), 'VALIDATION')
        expect(e.fields).toEqual({ handle: 'taken' })
      }
      // 예약어·형식.
      for (const [handle, reason] of [['settings', 'reserved'], ['admin', 'reserved'], ['a_b', 'invalid_format'], ['ab', 'too_short']] as const) {
        const e = await expectServiceError(createDisplayPersona(tx, B, { handle, displayName: '표시' }), 'VALIDATION')
        expect(e.fields).toEqual({ handle: reason })
      }
      // 둘째 표시명 페르소나 거부.
      await expectServiceError(createDisplayPersona(tx, f.A, { handle: `second-${tag()}`, displayName: '또 다른 나' }), 'CONFLICT', 'persona_exists')
      // 표시명 페르소나를 실명 handle로 바꿀 수도 없음.
      const e = await expectServiceError(updatePersona(tx, f.A, f.display.id, { handle: bHandle }), 'VALIDATION')
      expect(e.fields).toEqual({ handle: 'taken' })
      expect(await tx.select().from(personas).where(eq(personas.userId, f.user.id))).toHaveLength(2)
    })
  })

  it('PATCH /personas/:id: owner only (404 otherwise), handle change follows into profiles, real name stays the account name', async () => {
    await withRollback(async (tx) => {
      const f = await twoPersonas(tx)
      const other = await createUser(tx, { displayName: '남', handle: `n-${tag()}` })
      await expectServiceError(updatePersona(tx, { userId: other.id }, f.display.id, { displayName: '탈취' }), 'NOT_FOUND')
      await expectServiceError(updatePersona(tx, f.A, 'not-a-uuid', {}), 'NOT_FOUND')
      await expectServiceError(updatePersona(tx, f.A, f.real.id, { displayName: '바꾼 이름' }), 'VALIDATION')

      const next = `moon-${tag()}`
      const updated = await updatePersona(tx, f.A, f.display.id, { handle: next.toUpperCase(), displayName: '달의개발자', openToWork: true, accountPrivacy: 'private' })
      expect(updated).toMatchObject({ handle: next, displayName: '달의개발자', accountPrivacy: 'private', profile: { handle: next, openToWork: true } })
      const [row] = await tx.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.personaId, f.display.id))
      expect(row!.handle).toBe(next)
      await expectServiceError(getPublicPortfolioProfile(tx, f.display.handle, T0), 'NOT_FOUND')
      expect((await getPublicPortfolioProfile(tx, next, T0)).displayName).toBe('달의개발자')
      // 실명 handle 변경(온보딩 경로)도 페르소나와 프로필이 함께.
      const realNext = `sun-${tag()}`
      await upsertProfile(tx, f.A, { handle: realNext })
      const [realPersona] = await tx.select().from(personas).where(eq(personas.id, f.real.id))
      expect(realPersona!.handle).toBe(realNext)
      expect((await getMe(tx, f.A)).profile?.handle).toBe(realNext)
      // profiles.handle만 따로 바꾸는 것은 외래 키가 막음.
      await expect(tx.transaction(async (s) => s.update(profiles).set({ handle: `zz-${tag()}` }).where(eq(profiles.personaId, f.real.id)))).rejects.toThrow()
      // 감사(수정)에는 필드 이름만.
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.actorId, f.user.id), eq(auditEvents.action, 'persona.update')))
      expect(audits.map((a) => a.metadata)).toEqual([{ kind: 'display', fields: 'accountPrivacy,displayName,handle,openToWork' }])
    })
  })

  it('portfolio editions belong to a persona: real by default, display editions take no case studies, versions per persona', async () => {
    await withRollback(async (tx) => {
      const f = await twoPersonas(tx)
      const real1 = await createEdition(tx, f.A, { headline: '실명 판 한 줄', skillsDeclared: ['TypeScript'] }, T0)
      expect(real1).toMatchObject({ version: 1, persona: { id: f.real.id, kind: 'real' } })
      const fakeCase = crypto.randomUUID()
      const rejected = await expectServiceError(
        createEdition(tx, f.A, { personaId: f.display.id, featuredCaseStudyIds: [fakeCase] }, T0),
        'VALIDATION',
      )
      expect(rejected.fields).toEqual({ featuredCaseStudyIds: 'display_persona' })
      const display1 = await createEdition(tx, f.A, { personaId: f.display.id, headline: '표시명 판 한 줄', skillsDeclared: ['그림'] }, T0)
      expect(display1).toMatchObject({ version: 1, persona: { id: f.display.id, kind: 'display' } })
      const real2 = await createEdition(tx, f.A, { headline: '실명 판 둘째' }, T0)
      expect(real2.version).toBe(2)
      expect((await listMyEditions(tx, f.A)).map((e) => [e.persona.kind, e.version, e.current])).toEqual([
        ['real', 2, true],
        ['real', 1, false],
        ['display', 1, true],
      ])
      // 남의 페르소나에는 판을 붙일 수 없음.
      const other = await createUser(tx, { displayName: '남', handle: `n-${tag()}` })
      const notMine = await expectServiceError(createEdition(tx, { userId: other.id }, { personaId: f.display.id }, T0), 'VALIDATION')
      expect(notMine.fields).toEqual({ personaId: 'not_found' })

      const realView = await getPublicPortfolioProfile(tx, f.real.handle, T0)
      const displayView = await getPublicPortfolioProfile(tx, f.display.handle, T0)
      expect(realView.headline).toBe('실명 판 둘째')
      expect(displayView).toMatchObject({ headline: '표시명 판 한 줄', skillsDeclared: ['그림'], featured: [], timeline: [], juniorContribution: { planForks: 0, seniorNotes: 0, curatedCourses: [], stuckQaAnswers: 0 } })
      expect(JSON.stringify(displayView)).not.toContain('실명 판')
      expect(JSON.stringify(realView)).not.toContain('표시명 판')
    })
  })

  it('moderation hides one persona at a time; a link to a hidden or inactive persona is dropped', async () => {
    await withRollback(async (tx) => {
      const f = await twoPersonas(tx)
      await setIdentityLink(tx, f.A, { visible: true }, T0)
      await tx.update(profiles).set({ hiddenAt: T0 }).where(eq(profiles.personaId, f.real.id))
      await expectServiceError(getPublicPortfolioProfile(tx, f.real.handle, T0), 'NOT_FOUND')
      const display = await getPublicPortfolioProfile(tx, f.display.handle, T0)
      expect(display.linkedPersona).toBeNull()
      expectNothingOf(await publicBodies(tx, f.display.handle), f.real, 'hidden real')
      // 연결 행이 없는 사용자에게 토글은 409.
      const solo = await createUser(tx, { displayName: '혼자', handle: `s-${tag()}` })
      await expectServiceError(setIdentityLink(tx, { userId: solo.id }, { visible: true }), 'CONFLICT', 'no_display_persona')
      const [link] = await tx.select().from(identityLinks).where(eq(identityLinks.userId, f.user.id))
      expect(link).toMatchObject({ realPersonaId: f.real.id, displayPersonaId: f.display.id, visible: true })
    })
  })
})
