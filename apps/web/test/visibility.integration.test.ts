/**
 * S-03 항목별 공개 범위·과제 수행 목록 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * DELIVERY_PLAN §5.2 시나리오 S: 모든 항목을 전체 공개로 바꿔도 팀 동의가 끝나지 않은 공개 후보·비공개 과제 공간·엠바고 중인 과제 제목은 공개 프로필
 * (JSON·README 카드·이전 공개 프로필 DTO — HTML·인쇄 보기는 이 JSON만 그림, 브라우저 쪽은 apps/e2e s-visibility.spec.ts)에 없고, 과제 수행 목록에는
 * 고른 과제의 과목·학기·제목만 있으며 다른 멤버 이름·로그가 없습니다. 설정을 바꿔도 비공개 과제 공간의 읽기 결과는 같습니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import {
  and,
  auditEvents,
  courseTerms,
  courses,
  eq,
  projectListings,
  projectMembers,
  schools,
  sql,
  visibilitySettings,
  type DbExecutor,
} from '@peerchive/db'
import { getPublicProfile, upsertProfile } from '../server/modules/identity/profiles'
import { createLog } from '../server/modules/logs/logs'
import { createPublicProfileHandler, createReadmeCardHandler } from '../server/modules/portfolio/public-http'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { loadReadableProject } from '../server/modules/projects/access'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { leaveProject } from '../server/modules/projects/members'
import { createProject, getProject, insertProjectInTx } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { createDisplayPersona, listMyPersonas, updatePersona } from '../server/modules/social/personas'
import { getMyVisibility, getProfileProjects, listMyProjectListings, setProjectListing, setVisibility } from '../server/modules/social/visibility'
import { closeTestDb, createUser, databaseUrl, expectServiceError, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const tag = () => crypto.randomUUID().slice(0, 8)
const ALL_PUBLIC = { project_list: 'public', posts: 'public', notes_and_studies: 'public', follow_lists: 'public' }

async function school(db: DbExecutor, name = `시험대학교 ${tag()}`) {
  const [row] = await db.insert(schools).values({ name, nameKey: name.replace(/\s+/g, '').toLowerCase() }).returning({ id: schools.id })
  return row!.id
}

/** 과목 + 학기. ended면 학기가 이미 끝남(엠바고 없음), 아니면 T0 뒤에 끝남(엠바고 중). */
async function term(db: DbExecutor, schoolId: string, courseTitle: string, ended: boolean) {
  const [course] = await db.insert(courses).values({ schoolId, title: courseTitle, titleKey: courseTitle.replace(/\s+/g, '').toLowerCase() }).returning({ id: courses.id })
  const [row] = await db
    .insert(courseTerms)
    .values(
      ended
        ? { courseId: course!.id, year: 2025, semester: 'fall', endsAt: new Date('2026-02-28T14:59:59Z') }
        : { courseId: course!.id, year: 2026, semester: 'fall', endsAt: new Date('2027-02-28T14:59:59Z') },
    )
    .returning({ id: courseTerms.id })
  return row!.id
}

/** 실명 프로필(온보딩)을 가진 사용자. */
async function person(db: DbExecutor, name: string) {
  const handle = `v-${tag()}`
  const user = await createUser(db, { displayName: '임시' })
  const actor = { userId: user.id }
  await upsertProfile(db, actor, { handle, displayName: name, headline: `${name} 소개` })
  const realId = (await listMyPersonas(db, actor)).personas.find((p) => p.kind === 'real')!.id
  return { user, actor, handle, name, realId }
}

/** 공개 경로 전부(공개 프로필 JSON·README 카드 HTTP, 이전 공개 프로필 DTO)의 본문. */
async function publicBodies(db: DbExecutor, handle: string, now = T0): Promise<string> {
  const deps = { getDb: () => db, now: () => now, getEnv: () => ({}) }
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

/** 시나리오 S의 세계: 주인 A(학교 인증) + 팀원 B, 고른 과제(끝난 학기 팀 과제·엠바고 중 과제)와 고르지 않은 비공개 과제, 동의 대기 공개 후보. */
async function world(db: DbExecutor) {
  const t = tag()
  const schoolId = await school(db)
  const A = await person(db, `김주인${t}`)
  const B = await person(db, `박팀원${t}`)
  await verifiedAffiliation(db, A.user.id, schoolId)
  const pastTerm = await term(db, schoolId, `캡스톤디자인${t}`, true)
  const futureTerm = await term(db, schoolId, `운영체제${t}`, false)
  const team = await createProject(db, A.actor, { title: `도서관 혼잡도 ${t}`, kind: 'team', courseTermId: pastTerm }, T0)
  const { token } = await createInvitation(db, A.actor, team.id, { role: 'editor' }, T0)
  await acceptInvitation(db, B.actor, { token }, T0)
  const logBody = `비공개 로그 본문 LOGSENTINEL${t}`
  const log = (await createLog(db, B.actor, team.id, { tag: 'progress', body: logBody }, T0)).log
  const embargoed = await createProject(db, A.actor, { title: `엠바고 과제 EMBARGOSENTINEL${t}`, kind: 'individual', courseTermId: futureTerm }, T0)
  const hidden = await createProject(db, A.actor, { title: `비공개 과제 PRIVATESENTINEL${t}`, kind: 'individual' }, T0)
  // 팀원 B가 동의하지 않은 공개 후보(팀 과제).
  const candidate = await createCandidate(
    db,
    A.actor,
    team.id,
    {
      level: 'summary',
      title: `동의 대기 후보 CANDSENTINEL${t}`,
      summary: `동의 대기 요약 CANDSUMMARY${t}`,
      slug: `cand-${t}`,
      logIds: [log.id],
      exposure: { [A.user.id]: 'name', [B.user.id]: 'name' },
      consentSelf: true,
    },
    T0,
    ORIGINS,
  )
  expect(candidate.status).not.toBe('ready')
  return { t, schoolId, A, B, team, embargoed, hidden, candidate, log, logBody, pastTerm, futureTerm }
}

const show = (db: DbExecutor, who: { actor: { userId: string }; realId: string }, projectId: string, shown = true) =>
  setProjectListing(db, who.actor, who.realId, { projectId, shown }, T0)

describe.skipIf(!databaseUrl)('S-03 공개 범위 설정 API', () => {
  afterAll(closeTestDb)

  it('기본값을 계산해 보여 주고, 본인만 바꿀 수 있으며 남의 페르소나·없는 id는 404', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김설정')
      const other = await person(tx, '박남')
      const initial = await getMyVisibility(tx, A.actor, A.realId)
      expect(initial.items.map((i) => [i.itemKind, i.audience, i.isDefault])).toEqual([
        ['project_list', 'private', true],
        ['posts', 'signed_in', true],
        ['notes_and_studies', 'signed_in', true],
        ['follow_lists', 'private', true],
      ])
      expect(initial.items.find((i) => i.itemKind === 'follow_lists')!.allowed).toEqual(['public', 'private'])

      const updated = await setVisibility(tx, A.actor, A.realId, { items: { posts: 'same_institution', follow_lists: 'public' } }, T0)
      expect(updated.items.find((i) => i.itemKind === 'posts')).toMatchObject({ audience: 'same_institution', isDefault: false, effective: 'same_institution' })
      expect(updated.items.find((i) => i.itemKind === 'follow_lists')).toMatchObject({ audience: 'public', isDefault: false })
      expect(await tx.select().from(visibilitySettings).where(eq(visibilitySettings.personaId, A.realId))).toHaveLength(2)

      await expectServiceError(setVisibility(tx, other.actor, A.realId, { items: { posts: 'public' } }), 'NOT_FOUND')
      await expectServiceError(getMyVisibility(tx, other.actor, A.realId), 'NOT_FOUND')
      await expectServiceError(setVisibility(tx, A.actor, 'not-a-uuid', { items: { posts: 'public' } }), 'NOT_FOUND')
      await expectServiceError(setVisibility(tx, A.actor, crypto.randomUUID(), { items: { posts: 'public' } }), 'NOT_FOUND')
      // 남의 페르소나에는 입력이 틀려도 404(존재를 드러내지 않음).
      await expectServiceError(setVisibility(tx, other.actor, A.realId, { items: { cases: 'public' } }), 'NOT_FOUND')

      // 감사: 항목 이름·종류만.
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'persona.visibility_update'), eq(auditEvents.targetId, A.realId)))
      expect(audits.map((a) => a.metadata)).toEqual([{ kind: 'real', items: 'follow_lists,posts' }])
      // 같은 값이면 쓰지 않음.
      await setVisibility(tx, A.actor, A.realId, { items: { posts: 'same_institution' } }, T0)
      expect(await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'persona.visibility_update'), eq(auditEvents.targetId, A.realId)))).toHaveLength(1)
    })
  })

  it('목록 밖 항목(공개 사례·케이스 스터디 포함)은 422, follow_lists는 public·private만, 빈 요청 422', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김검증')
      const e1 = await expectServiceError(setVisibility(tx, A.actor, A.realId, { items: { case_studies: 'public' } }), 'VALIDATION')
      expect(e1.fields).toEqual({ 'items.case_studies': 'publication_procedure' })
      const e2 = await expectServiceError(setVisibility(tx, A.actor, A.realId, { items: { cases: 'public', publications: 'signed_in', avatar: 'public' } }), 'VALIDATION')
      expect(e2.fields).toEqual({ 'items.cases': 'publication_procedure', 'items.publications': 'publication_procedure', 'items.avatar': 'unknown_item' })
      for (const bad of ['signed_in', 'same_institution', 'approved_followers', 'everyone', 1, null]) {
        const e = await expectServiceError(setVisibility(tx, A.actor, A.realId, { items: { follow_lists: bad } }), 'VALIDATION')
        expect(e.fields).toEqual({ 'items.follow_lists': 'invalid' })
      }
      expect((await expectServiceError(setVisibility(tx, A.actor, A.realId, { items: { posts: 'everyone' } }), 'VALIDATION')).fields).toEqual({ 'items.posts': 'invalid' })
      for (const body of [{}, { items: {} }, { items: [] }, null, { items: 'public' }])
        expect((await expectServiceError(setVisibility(tx, A.actor, A.realId, body), 'VALIDATION')).fields).toEqual({ items: 'required' })
      // 한 항목이라도 틀리면 아무것도 쓰지 않음.
      await expectServiceError(setVisibility(tx, A.actor, A.realId, { items: { posts: 'public', cases: 'public' } }), 'VALIDATION')
      expect(await tx.select().from(visibilitySettings).where(eq(visibilitySettings.personaId, A.realId))).toHaveLength(0)
      // DB도 follow_lists의 다른 값을 거부.
      await expect(
        tx.transaction((inner) => inner.insert(visibilitySettings).values({ personaId: A.realId, itemKind: 'follow_lists', audience: 'signed_in' })),
      ).rejects.toThrow()
    })
  })

  it('비공개 계정은 기본값이 approved_followers이고, 저장 값이 넓어도 적용 값은 approved_followers', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김비공개')
      await updatePersona(tx, A.actor, A.realId, { accountPrivacy: 'private' }, T0)
      const v = await setVisibility(tx, A.actor, A.realId, { items: { project_list: 'public' } }, T0)
      expect(v.items.map((i) => [i.itemKind, i.audience, i.effective])).toEqual([
        ['project_list', 'public', 'approved_followers'],
        ['posts', 'approved_followers', 'approved_followers'],
        ['notes_and_studies', 'approved_followers', 'approved_followers'],
        ['follow_lists', 'private', 'private'],
      ])
    })
  })
})

describe.skipIf(!databaseUrl)('S-03 과제 수행 목록', () => {
  afterAll(closeTestDb)

  it('시나리오 S: 모두 전체 공개여도 공개 후보·비공개 과제·엠바고 제목·다른 멤버·로그는 공개 경로에 없고, 고른 과제의 과목·학기·제목만 있다', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      await setVisibility(tx, w.A.actor, w.A.realId, { items: ALL_PUBLIC }, T0)
      await show(tx, w.A, w.team.id)
      await show(tx, w.A, w.embargoed.id)

      const profile = await getPublicPortfolioProfile(tx, w.A.handle, T0)
      expect(profile.projects).toEqual([
        // 최근 학기 먼저. 엠바고 중이면 제목 없이 과목·학기만.
        { courseTitle: `운영체제${w.t}`, termLabel: '2026년 2학기', title: null },
        { courseTitle: `캡스톤디자인${w.t}`, termLabel: '2025년 2학기', title: `도서관 혼잡도 ${w.t}` },
      ])
      for (const p of profile.projects ?? []) expect(Object.keys(p).sort()).toEqual(['courseTitle', 'termLabel', 'title'])
      // 공개 사례 목록(타임라인·대표 케이스)은 공개 범위와 무관하게 공개 절차를 거친 것만: 동의 대기 후보는 없음.
      expect(profile.timeline).toEqual([])
      expect(profile.featured).toEqual([])

      const body = await publicBodies(tx, w.A.handle)
      expect(body).toContain(`도서관 혼잡도 ${w.t}`)
      expect(body).toContain(`캡스톤디자인${w.t}`)
      expect(body).toContain('과제 수행 목록')
      for (const secret of [
        `EMBARGOSENTINEL${w.t}`,
        `PRIVATESENTINEL${w.t}`,
        `CANDSENTINEL${w.t}`,
        `CANDSUMMARY${w.t}`,
        `cand-${w.t}`,
        w.candidate.id,
        `LOGSENTINEL${w.t}`,
        w.log.id,
        w.B.name,
        w.B.handle,
        w.B.user.id,
        w.team.id,
        w.embargoed.id,
        w.hidden.id,
        w.A.user.id,
      ])
        expect(body, secret.slice(0, 12)).not.toContain(secret)
    })
  })

  it('엠바고가 풀리면 다음 요청부터 제목이 보이고, 내리면 사라진다', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      await setVisibility(tx, w.A.actor, w.A.realId, { items: { project_list: 'public' } }, T0)
      await show(tx, w.A, w.embargoed.id)
      const later = new Date('2027-03-02T00:00:00Z')
      expect((await getPublicPortfolioProfile(tx, w.A.handle, later)).projects).toEqual([
        { courseTitle: `운영체제${w.t}`, termLabel: '2026년 2학기', title: `엠바고 과제 EMBARGOSENTINEL${w.t}` },
      ])
      await show(tx, w.A, w.embargoed.id, false)
      expect((await getPublicPortfolioProfile(tx, w.A.handle, later)).projects).toEqual([])
      // 다시 올리면 같은 행이 되살아남(행은 하나).
      await show(tx, w.A, w.embargoed.id)
      expect(await tx.select().from(projectListings).where(eq(projectListings.personaId, w.A.realId))).toHaveLength(1)
    })
  })

  it('고르기 화면: 내가 active 멤버인 과제만, 본인에게는 엠바고 중에도 제목, 익명 스터디 기록은 올릴 수 없음', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const study = await insertProjectInTx(
        tx,
        w.A.user.id,
        { title: `익명 스터디 ANONSTUDY${w.t}`, kind: 'individual', courseTermId: null, summaryByStudent: null, goal: null, constraints: null, retroMode: false },
        'study',
        { nameMode: 'anonymous', schoolId: null },
      )
      const displayStudy = await insertProjectInTx(
        tx,
        w.A.user.id,
        { title: `표시명 스터디 ${w.t}`, kind: 'individual', courseTermId: null, summaryByStudent: null, goal: null, constraints: null, retroMode: false },
        'study',
        { nameMode: 'display', schoolId: null },
      )
      const realStudy = await insertProjectInTx(
        tx,
        w.A.user.id,
        { title: `실명 스터디 ${w.t}`, kind: 'individual', courseTermId: null, summaryByStudent: null, goal: null, constraints: null, retroMode: false },
        'study',
        { nameMode: 'real', schoolId: null },
      )
      await expectServiceError(show(tx, w.A, study.id), 'CONFLICT', 'anonymous_study')
      await expectServiceError(show(tx, w.A, displayStudy.id), 'CONFLICT', 'display_study')
      await show(tx, w.A, realStudy.id)
      // 남의 과제·없는 과제·잘못된 id는 404.
      const outsider = await person(tx, '최외부')
      const theirs = await createProject(tx, outsider.actor, { title: '남의 과제' }, T0)
      await expectServiceError(show(tx, w.A, theirs.id), 'NOT_FOUND')
      await expectServiceError(show(tx, w.A, crypto.randomUUID()), 'NOT_FOUND')
      await expectServiceError(setProjectListing(tx, w.A.actor, w.A.realId, { projectId: 'x', shown: true }, T0), 'NOT_FOUND')
      expect((await expectServiceError(setProjectListing(tx, w.A.actor, w.A.realId, { projectId: w.team.id }, T0), 'VALIDATION')).fields).toEqual({ shown: 'required' })
      // 남의 페르소나로는 404.
      await expectServiceError(setProjectListing(tx, outsider.actor, w.A.realId, { projectId: w.team.id, shown: true }, T0), 'NOT_FOUND')
      await expectServiceError(listMyProjectListings(tx, outsider.actor, w.A.realId, T0), 'NOT_FOUND')

      const mine = await listMyProjectListings(tx, w.A.actor, w.A.realId, T0)
      expect(mine.audience).toBe('private')
      const byId = new Map(mine.projects.map((p) => [p.projectId, p]))
      expect(byId.get(w.embargoed.id)).toMatchObject({ title: `엠바고 과제 EMBARGOSENTINEL${w.t}`, embargoActive: true, listed: false, block: null })
      expect(byId.get(study.id)).toMatchObject({ block: 'anonymous_study', listed: false })
      expect(byId.get(displayStudy.id)).toMatchObject({ block: 'display_study', listed: false })
      expect(byId.get(realStudy.id)).toMatchObject({ block: null, listed: true, courseTitle: null, termLabel: null })
      expect(byId.has(theirs.id)).toBe(false)

      // 감사에는 플래그만.
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'persona.project_listing_update'), eq(auditEvents.targetId, w.A.realId)))
      expect(audits.map((a) => a.metadata)).toEqual([{ shown: true }])

      // 방 이름 표시 방식이 나중에 익명으로 바뀌면(행이 남아 있어도) 읽을 때 빠짐.
      await setVisibility(tx, w.A.actor, w.A.realId, { items: { project_list: 'public' } }, T0)
      expect((await getPublicPortfolioProfile(tx, w.A.handle, T0)).projects).toHaveLength(1)
      await tx.execute(sql`update projects set study_name_mode = 'anonymous' where id = ${realStudy.id}`)
      expect((await getPublicPortfolioProfile(tx, w.A.handle, T0)).projects).toEqual([])
    })
  })

  it('멤버십이 끝나면(나감) 목록에서 빠짐', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      await setVisibility(tx, w.B.actor, w.B.realId, { items: { project_list: 'public' } }, T0)
      await show(tx, w.B, w.team.id)
      expect((await getPublicPortfolioProfile(tx, w.B.handle, T0)).projects).toHaveLength(1)
      await leaveProject(tx, w.B.actor, w.team.id)
      expect((await getPublicPortfolioProfile(tx, w.B.handle, T0)).projects).toEqual([])
    })
  })

  it('표시명 페르소나: 과제 수행 목록을 둘 수 없고(409·422) 공개 DTO의 projects는 늘 null', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const display = await createDisplayPersona(tx, w.A.actor, { handle: `night-${w.t}`, displayName: `밤의개발자${w.t}` }, T0)
      await expectServiceError(listMyProjectListings(tx, w.A.actor, display.id, T0), 'CONFLICT', 'real_persona_only')
      await expectServiceError(setProjectListing(tx, w.A.actor, display.id, { projectId: w.team.id, shown: true }, T0), 'CONFLICT', 'real_persona_only')
      const e = await expectServiceError(setVisibility(tx, w.A.actor, display.id, { items: { project_list: 'public' } }), 'VALIDATION')
      expect(e.fields).toEqual({ 'items.project_list': 'real_persona_only' })
      const v = await setVisibility(tx, w.A.actor, display.id, { items: { project_list: 'private', posts: 'same_institution' } }, T0)
      expect(v.items.find((i) => i.itemKind === 'project_list')!.allowed).toEqual(['private'])
      // DB도 표시명 페르소나 행을 거부(persona_kind check·복합 외래 키).
      const [member] = await tx.select({ id: projectMembers.id }).from(projectMembers).where(and(eq(projectMembers.projectId, w.team.id), eq(projectMembers.userId, w.A.user.id)))
      await expect(
        tx.transaction((inner) => inner.insert(projectListings).values({ projectMemberId: member!.id, personaId: display.id, personaKind: 'display', userId: w.A.user.id })),
      ).rejects.toThrow()
      await expect(
        tx.transaction((inner) => inner.insert(projectListings).values({ projectMemberId: member!.id, personaId: display.id, userId: w.A.user.id })),
      ).rejects.toThrow()
      // 다른 사람의 멤버십을 내 페르소나에 거는 것도 DB가 거부.
      const [bMember] = await tx.select({ id: projectMembers.id }).from(projectMembers).where(and(eq(projectMembers.projectId, w.team.id), eq(projectMembers.userId, w.B.user.id)))
      await expect(
        tx.transaction((inner) => inner.insert(projectListings).values({ projectMemberId: bMember!.id, personaId: w.A.realId, userId: w.A.user.id })),
      ).rejects.toThrow()

      // 실명 쪽을 전체 공개로 올려도 표시명 프로필에는 과제가 없음.
      await setVisibility(tx, w.A.actor, w.A.realId, { items: ALL_PUBLIC }, T0)
      await show(tx, w.A, w.team.id)
      expect((await getPublicPortfolioProfile(tx, display.handle, T0)).projects).toBeNull()
      expect((await getProfileProjects(tx, w.A.actor, display.handle, T0)).projects).toBeNull()
      const body = await publicBodies(tx, display.handle)
      expect(body).not.toContain(`도서관 혼잡도 ${w.t}`)
      expect(body).not.toContain(`캡스톤디자인${w.t}`)
    })
  })

  it('비공개 과제 공간의 접근 결과는 설정·목록 변경 전후로 같다', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const outsider = await person(tx, '정외부')
      await verifiedAffiliation(tx, outsider.user.id, w.schoolId)
      const probe = async () => {
        const results: string[] = []
        for (const [who, actor] of [['A', w.A.actor], ['B', w.B.actor], ['outsider', outsider.actor]] as const) {
          for (const p of [w.team, w.embargoed, w.hidden]) {
            const r = await loadReadableProject(tx, actor, p.id).then(
              (ctx) => `ok:${ctx.membership.role}`,
              (e: { code?: string }) => e.code ?? 'error',
            )
            const d = await getProject(tx, actor, p.id, T0).then(
              () => 'ok',
              (e: { code?: string }) => e.code ?? 'error',
            )
            results.push(`${who}/${p.title.slice(0, 6)}:${r}:${d}`)
          }
        }
        const members = await tx.select({ userId: projectMembers.userId, role: projectMembers.role, status: projectMembers.status }).from(projectMembers).where(eq(projectMembers.projectId, w.team.id))
        return { results, members: members.sort((a, b) => a.userId.localeCompare(b.userId)) }
      }
      const before = await probe()
      expect(before.results.filter((r) => r.startsWith('outsider/')).every((r) => r.endsWith(':NOT_FOUND:NOT_FOUND'))).toBe(true)
      await setVisibility(tx, w.A.actor, w.A.realId, { items: ALL_PUBLIC }, T0)
      await show(tx, w.A, w.team.id)
      await show(tx, w.A, w.embargoed.id)
      expect(await probe()).toEqual(before)
      await setVisibility(tx, w.A.actor, w.A.realId, { items: { project_list: 'private' } }, T0)
      await show(tx, w.A, w.team.id, false)
      expect(await probe()).toEqual(before)
    })
  })
})

describe.skipIf(!databaseUrl)('S-03 보는 사람 기준 판정(canViewPersonaItem, GET /profiles/:handle)', () => {
  afterAll(closeTestDb)

  it('audience별로 비로그인·로그인·같은 기관·본인이 보는 것이 다르고, 공개 경로(쿠키 없음)는 늘 비로그인으로 판정한다', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      await show(tx, w.A, w.team.id)
      const sameSchool = await person(tx, '한동문')
      await verifiedAffiliation(tx, sameSchool.user.id, w.schoolId)
      const otherSchool = await person(tx, '오타교')
      await verifiedAffiliation(tx, otherSchool.user.id, await school(tx))
      const signedIn = await person(tx, '윤로그인')
      const viewers = { anonymous: null, signedIn: signedIn.actor, otherSchool: otherSchool.actor, sameSchool: sameSchool.actor, owner: w.A.actor }
      const sees = async () => {
        const out: Record<string, boolean> = {}
        for (const [name, actor] of Object.entries(viewers)) out[name] = (await getProfileProjects(tx, actor, w.A.handle, T0)).projects !== null
        out.publicPath = (await getPublicPortfolioProfile(tx, w.A.handle, T0)).projects !== null
        return out
      }
      const expected = {
        public: { anonymous: true, signedIn: true, otherSchool: true, sameSchool: true, owner: true, publicPath: true },
        signed_in: { anonymous: false, signedIn: true, otherSchool: true, sameSchool: true, owner: true, publicPath: false },
        same_institution: { anonymous: false, signedIn: false, otherSchool: false, sameSchool: true, owner: true, publicPath: false },
        // 팔로우(S-04) 전에는 본인만.
        approved_followers: { anonymous: false, signedIn: false, otherSchool: false, sameSchool: false, owner: true, publicPath: false },
        private: { anonymous: false, signedIn: false, otherSchool: false, sameSchool: false, owner: true, publicPath: false },
      } as const
      // 기본값(행 없음) = private.
      expect(await sees()).toEqual(expected.private)
      for (const [audience, want] of Object.entries(expected)) {
        await setVisibility(tx, w.A.actor, w.A.realId, { items: { project_list: audience } }, T0)
        expect(await sees(), audience).toEqual(want)
      }
      // 보이면 내용은 같음(과목·학기·제목).
      await setVisibility(tx, w.A.actor, w.A.realId, { items: { project_list: 'same_institution' } }, T0)
      expect((await getProfileProjects(tx, sameSchool.actor, w.A.handle, T0)).projects).toEqual([
        { courseTitle: `캡스톤디자인${w.t}`, termLabel: '2025년 2학기', title: `도서관 혼잡도 ${w.t}` },
      ])
      // 같은 기관 인증을 해제하면 다음 요청부터 못 봄.
      await tx.execute(sql`update institution_affiliations set status = 'revoked', revoked_at = now(), revoked_reason = 'user_removed', email_hash = null where user_id = ${sameSchool.user.id}`)
      expect((await getProfileProjects(tx, sameSchool.actor, w.A.handle, T0)).projects).toBeNull()

      // 비공개 계정은 전체 공개로 저장해도 본인만(팔로우 전).
      await setVisibility(tx, w.A.actor, w.A.realId, { items: { project_list: 'public' } }, T0)
      await updatePersona(tx, w.A.actor, w.A.realId, { accountPrivacy: 'private' }, T0)
      expect((await getProfileProjects(tx, signedIn.actor, w.A.handle, T0)).projects).toBeNull()
      expect((await getPublicPortfolioProfile(tx, w.A.handle, T0)).projects).toBeNull()
      expect((await getProfileProjects(tx, w.A.actor, w.A.handle, T0)).projects).toHaveLength(1)

      await expectServiceError(getProfileProjects(tx, null, `nobody-${w.t}`, T0), 'NOT_FOUND')
    })
  })
})

describe.skipIf(!databaseUrl)('S-03 social DB 역할로 과제 수행 목록 읽기', () => {
  afterAll(closeTestDb)

  it('peerchive_social은 목록 계산에 쓰는 열만 읽고(과제 설명·로그 없음), 그 역할로 목록 경로가 그대로 동작한다', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const viewer = await person(tx, '한동문')
      await verifiedAffiliation(tx, viewer.user.id, w.schoolId)
      await setVisibility(tx, w.A.actor, w.A.realId, { items: { project_list: 'same_institution' } }, T0)
      await show(tx, w.A, w.team.id)
      await show(tx, w.A, w.embargoed.id)
      const expected = await getProfileProjects(tx, viewer.actor, w.A.handle, T0)
      expect(expected.projects).toHaveLength(2)

      const col = async (table: string, column: string) =>
        ((await tx.execute(sql`select has_column_privilege('peerchive_social', ${`public.${table}`}, ${column}, 'SELECT') as ok`)) as unknown as Array<{ ok: boolean }>)[0]!.ok
      for (const [table, column] of <Array<[string, string]>>[['projects', 'title'], ['projects', 'embargo_until'], ['course_terms', 'year'], ['courses', 'title'], ['institution_affiliations', 'school_id'], ['project_members', 'status']])
        expect(await col(table, column), `${table}.${column}`).toBe(true)
      for (const [table, column] of <Array<[string, string]>>[['projects', 'goal'], ['projects', 'summary_by_student'], ['project_members', 'role'], ['institution_affiliations', 'email_hash'], ['institution_affiliations', 'department_label'], ['courses', 'created_by']])
        expect(await col(table, column), `${table}.${column}`).toBe(false)
      for (const t of ['log_entries', 'artifacts', 'publication_candidates', 'invitations'])
        expect(((await tx.execute(sql`select has_table_privilege('peerchive_social', ${`public.${t}`}, 'SELECT') as ok`)) as unknown as Array<{ ok: boolean }>)[0]!.ok, t).toBe(false)

      await tx.transaction(async (inner) => {
        await inner.execute(sql.raw('set local role peerchive_social'))
        expect(await getProfileProjects(inner, viewer.actor, w.A.handle, T0)).toEqual(expected)
        expect((await getProfileProjects(inner, null, w.A.handle, T0)).projects).toBeNull()
        await inner.execute(sql.raw('reset role'))
      })
    })
  })
})

