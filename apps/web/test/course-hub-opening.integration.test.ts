/**
 * E-02 과목 허브 단계적 개방 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * - 플래그 꺼짐: 지금처럼 항상 열린 허브, 본인 화면 API는 404.
 * - 플래그 켜짐: 공개 사례 + 선배 노트가 기준 미만이면 "준비 중"(JSON·HTTP에 내용 목록 없음), 기준에 이르면 다음 요청부터 열림.
 *   병합된 과목은 정본으로 합산, 숨김·초안 노트와 철회·엠바고 중인 release는 세지 않음. 검색의 노트 결과는 준비 중 과목이면 빠짐.
 * - 열리면 알려 주세요(등록한 학생만, 멱등) → 열린 뒤 홈 알림(한 번만 기록), 마친 학생에게 선배 노트 요청, 운영자 진행 화면(집계만).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import { searchDocFromSeniorNote } from '@peerchive/domain'
import {
  and,
  courseHubNotices,
  courseRegistrations,
  eq,
  operators,
  publicationCandidates,
  searchDocuments,
  seniorNotes,
  type DbExecutor,
} from '@peerchive/db'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { mergeCourse } from '../server/modules/catalog/merge'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { createPublicCourseHubHandler } from '../server/modules/course-hub/public-http'
import { searchPublic } from '../server/modules/course-hub/search'
import { createSeniorNote, publishSeniorNote } from '../server/modules/course-hub/senior-notes'
import { getCourseHubView, getHubOpeningProgress } from '../server/modules/course-hub/staged-opening'
import {
  cancelHubOpenNotify,
  dismissHubNoteRequest,
  dismissHubOpenedNotice,
  getMyHubOpening,
  listMyHubNotices,
  requestHubOpenNotify,
} from '../server/modules/course-registrations/hub-opening'
import { registerCourse } from '../server/modules/course-registrations/registrations'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { createLog } from '../server/modules/logs/logs'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z') // 2026년 2학기 진행 중
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const ON = { PEERCHIVE_FEATURE_HUB_STAGED_OPENING: 'on' }
const CONTENT_KEYS = ['cases', 'stuckItems', 'seniorNotes', 'qaItems', 'workload', 'otherSchools', 'enrollment', 'conceptTags']

const NOTE_INPUT = {
  displayMode: 'anonymous',
  termLabel: '2025년 2학기',
  totalTimeBucket: 'lt40h',
  answers: { firstWeek: '명세를 끝까지 읽기', timeSink: '디버깅에 오래 걸림', wishKnew: '시그널 개념' },
  noAnswersConfirmed: true,
}

async function courseFixture(db: DbExecutor, userId: string, schoolId?: string) {
  const t = token()
  const school = schoolId ? { id: schoolId } : await createSchool(db, { userId }, { name: `개방대${t}학교`, confirmNew: true }, T0)
  const course = await createCourse(db, { userId }, school.id, { title: `자료구조${t}`, code: `DS-${t}`, confirmNew: true }, T0)
  // 2025년 2학기: 이미 끝난 학기(엠바고 없음).
  const { term } = await createCourseTerm(db, { userId }, course.id, { year: 2025, semester: 'fall' }, T0)
  return { schoolId: school.id, course, term }
}

/** 지난 학기 과목에 연결된 개인 과제를 요약 공개로 게시합니다. */
async function publishCase(db: DbExecutor, owner: string, termId: string, title = '공개 사례') {
  const actor = { userId: owner }
  const project = await createProject(db, actor, { title: `작업 ${title}`, courseTermId: termId }, T0)
  const log = (await createLog(db, actor, project.id, { tag: 'progress', body: '진행 기록', links: [] }, at(1))).log
  const candidate = await createCandidate(
    db,
    actor,
    project.id,
    {
      level: 'summary',
      title,
      summary: '요약',
      slug: `case-${crypto.randomUUID().slice(0, 8)}`,
      logIds: [log.id],
      milestoneIds: [],
      exposure: { [owner]: 'name' },
      consentSelf: true,
    },
    at(2),
    ORIGINS,
  )
  expect(candidate.status).toBe('ready')
  const result = await publishCandidate(db, actor, candidate.id, { manifestHash: candidate.manifestHash }, at(3))
  return { project, publication: result.publication }
}

async function publishNote(db: DbExecutor, author: string, courseId: string) {
  const note = await createSeniorNote(db, { userId: author }, courseId, NOTE_INPUT, at(4))
  await publishSeniorNote(db, { userId: author }, note.id, { expectedVersion: 1 }, at(5))
  return note
}

describe.skipIf(!databaseUrl)('E-02 course hub staged opening (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('flag off (default): hub is always open with its content lists, and the personal staged-opening APIs are 404', async () => {
    setFeatureEnvForTesting({})
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const { course } = await courseFixture(tx, owner.id)
      const view = await getCourseHubView(tx, course.id, at(10))
      expect(view).toMatchObject({ status: 'open', cases: [], seniorNotes: [] })
      expect(view).toEqual(await getPublicCourseHub(tx, course.id, at(10)))
      const me = { userId: owner.id }
      await expectServiceError(getMyHubOpening(tx, me, course.id, at(10)), 'NOT_FOUND')
      await expectServiceError(requestHubOpenNotify(tx, me, course.id, at(10)), 'NOT_FOUND')
      await expectServiceError(listMyHubNotices(tx, me, at(10)), 'NOT_FOUND')
      await expectServiceError(dismissHubNoteRequest(tx, me, course.id, at(10)), 'NOT_FOUND')
      // P2 묶음 스위치로는 켜지지 않습니다.
      setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2: 'on' })
      expect((await getCourseHubView(tx, course.id, at(10))).status).toBe('open')
    })
  })

  it('below the threshold the hub is "preparing" with no content lists; drafts, hidden notes, withdrawn and embargoed releases do not count; reaching it opens on the next request', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      await verifiedAffiliation(tx, owner.id, schoolId)
      const actor = { userId: owner.id }

      const empty = await getCourseHubView(tx, course.id, at(10))
      expect(empty).toEqual({
        status: 'preparing',
        course: { id: course.id, title: course.title, code: course.code, school: { name: expect.any(String) }, authoredBy: 'student' },
        opening: { count: 0, threshold: 3 },
      })

      const live = await publishCase(tx, owner.id, term.id, '공개 중 사례')
      await publishNote(tx, owner.id, course.id)
      // 세지 않는 것: 초안 노트, 숨긴 노트, 철회한 사례, 엠바고 중인 사례.
      await createSeniorNote(tx, actor, course.id, NOTE_INPUT, at(6))
      const hidden = await publishNote(tx, owner.id, course.id)
      await tx.update(seniorNotes).set({ status: 'hidden' }).where(eq(seniorNotes.id, hidden.id))
      const withdrawn = await publishCase(tx, owner.id, term.id, '철회한 사례')
      await withdrawPublication(tx, actor, withdrawn.publication.id, {}, at(7))
      const embargoed = await publishCase(tx, owner.id, term.id, '엠바고 사례')
      await addProjectEmbargo(tx, actor, embargoed.project.id, { until: '2027-06-01T00:00:00Z', reason: '재수강' }, at(8))

      const preparing = await getCourseHubView(tx, course.id, at(10))
      expect(preparing).toMatchObject({ status: 'preparing', opening: { count: 2, threshold: 3 } })
      for (const key of CONTENT_KEYS) expect(preparing).not.toHaveProperty(key)
      expect(JSON.stringify(preparing)).not.toContain('공개 중 사례')
      // 이미 공개된 사례 자체는 그대로 열려 있습니다(허브 모음만 가림).
      expect((await getPublicCourseHub(tx, course.id, at(10))).cases.map((c) => c.slug)).toEqual([live.publication.slug])

      // HTTP: 같은 "준비 중" 모양(내용 목록 없음, noindex).
      const deps = { getDb: () => tx, getEnv: () => ({}), now: () => at(10) }
      const handler = toWebHandler(createApp().use(createRouter().get('/api/v1/public/courses/:id', createPublicCourseHubHandler(deps))))
      const res = await handler(new Request(`http://localhost:3000/api/v1/public/courses/${course.id}`))
      expect(res.status).toBe(200)
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      const body = (await res.json()) as Record<string, unknown>
      expect(body.status).toBe('preparing')
      for (const key of CONTENT_KEYS) expect(body).not.toHaveProperty(key)

      // 기준값은 설정으로 바꿉니다.
      setFeatureEnvForTesting({ ...ON, PEERCHIVE_HUB_OPEN_THRESHOLD: '2' })
      expect((await getCourseHubView(tx, course.id, at(10))).status).toBe('open')
      setFeatureEnvForTesting(ON)

      // 세 번째 항목이 공개되면 다음 요청부터 열립니다(수동 조작 없음).
      await publishNote(tx, owner.id, course.id)
      const open = await getCourseHubView(tx, course.id, at(11))
      expect(open.status).toBe('open')
      if (open.status !== 'open') throw new Error('expected open')
      expect(open.cases.map((c) => c.title)).toEqual(['공개 중 사례'])
      expect(open.seniorNotes).toHaveLength(2)
      // 엠바고가 풀리면 그 사례도 셉니다(같은 판정).
      expect((await getCourseHubView(tx, course.id, new Date('2027-07-01T00:00:00Z'))).status).toBe('open')
      // 다시 기준 밑으로 내려가면 "준비 중"입니다.
      await withdrawPublication(tx, actor, live.publication.id, {}, at(12))
      expect((await getCourseHubView(tx, course.id, at(13))).status).toBe('preparing')
      await expectServiceError(getCourseHubView(tx, crypto.randomUUID(), at(13)), 'NOT_FOUND')
    })
  })

  it('merged courses are counted canonically, and the merged id resolves to the canonical hub', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const operator = await createUser(tx)
      await tx.insert(operators).values({ userId: operator.id })
      const a = await courseFixture(tx, owner.id)
      const b = await courseFixture(tx, owner.id, a.schoolId)
      await verifiedAffiliation(tx, owner.id, a.schoolId)
      await publishCase(tx, owner.id, a.term.id, '정본 사례')
      const caseB = await publishCase(tx, owner.id, b.term.id, '병합될 사례')
      await publishNote(tx, owner.id, b.course.id)
      expect((await getCourseHubView(tx, a.course.id, at(10))).status).toBe('preparing')

      await mergeCourse(tx, { userId: operator.id }, b.course.id, { into: a.course.id }, at(9))
      // 정리 전처럼 원본 id를 가리키는 행이 남아 있어도 정본으로 셉니다.
      await tx.update(publicationCandidates).set({ courseId: b.course.id }).where(eq(publicationCandidates.publicationId, caseB.publication.id))
      const viaMerged = await getCourseHubView(tx, b.course.id, at(10))
      expect(viaMerged).toMatchObject({ status: 'open', course: { id: a.course.id } })
      expect((await getCourseHubView(tx, a.course.id, at(10))).status).toBe('open')
    })
  })

  it('search drops note results of a preparing hub (they live only on the hub page) and keeps case results; they return once it opens', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      await verifiedAffiliation(tx, owner.id, schoolId)
      const note = await publishNote(tx, owner.id, course.id)
      const [row] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, note.id))
      await tx.insert(searchDocuments).values({
        kind: 'note',
        seniorNoteId: row!.id,
        noteVersion: row!.version,
        ...searchDocFromSeniorNote({ answers: row!.answers, termLabel: row!.termLabel }),
      })
      const q = { q: '디버깅', course: course.id }
      expect((await searchPublic(tx, q, at(10))).results).toEqual([])
      setFeatureEnvForTesting({})
      expect((await searchPublic(tx, q, at(10))).results.map((r) => r.kind)).toEqual(['note'])
      setFeatureEnvForTesting(ON)
      await publishCase(tx, owner.id, term.id)
      await publishCase(tx, owner.id, term.id)
      expect((await searchPublic(tx, q, at(10))).results.map((r) => r.kind)).toEqual(['note'])
    })
  })

  it('a registered student asks to be notified (idempotent, own only); when the hub opens, home shows one opened notice until dismissed', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      await verifiedAffiliation(tx, owner.id, schoolId)
      const student = { userId: (await createUser(tx)).id }
      const stranger = { userId: (await createUser(tx)).id }
      await registerCourse(tx, student, { courseId: course.id, year: 2026, semester: 'fall' }, T0)

      expect(await getMyHubOpening(tx, student, course.id, at(10))).toEqual({
        courseId: course.id,
        status: 'preparing',
        count: 0,
        threshold: 3,
        registered: true,
        finished: false,
        notifyRequested: false,
        wroteNote: false,
      })
      await expectServiceError(requestHubOpenNotify(tx, stranger, course.id, at(10)), 'FORBIDDEN', 'not_registered')
      expect(await requestHubOpenNotify(tx, student, course.id, at(10))).toEqual({ requested: true })
      expect(await requestHubOpenNotify(tx, student, course.id, at(11))).toEqual({ requested: true })
      expect((await getMyHubOpening(tx, student, course.id, at(11))).notifyRequested).toBe(true)
      // 다른 사람에게는 내 신청이 보이지 않습니다.
      expect((await getMyHubOpening(tx, stranger, course.id, at(11))).notifyRequested).toBe(false)
      expect(await listMyHubNotices(tx, student, at(11))).toEqual({ opened: [], noteRequests: [] })

      // 취소했다가 다시 신청.
      await cancelHubOpenNotify(tx, student, course.id, at(12))
      expect((await getMyHubOpening(tx, student, course.id, at(12))).notifyRequested).toBe(false)
      await requestHubOpenNotify(tx, student, course.id, at(12))

      for (let i = 0; i < 3; i++) await publishCase(tx, owner.id, term.id, `사례 ${i}`)
      const first = await listMyHubNotices(tx, student, at(20))
      expect(first.opened).toEqual([{ id: expect.any(String), course: expect.objectContaining({ id: course.id }), openedAt: at(20).toISOString() }])
      // 다시 읽어도 한 번만 기록(시각 그대로), 행도 하나.
      expect((await listMyHubNotices(tx, student, at(25))).opened).toEqual(first.opened)
      expect(await tx.select().from(courseHubNotices).where(eq(courseHubNotices.userId, student.userId))).toHaveLength(1)
      // 이미 열렸으면 신청할 수 없습니다.
      await expectServiceError(requestHubOpenNotify(tx, student, course.id, at(26)), 'CONFLICT', 'already_open')

      await expectServiceError(dismissHubOpenedNotice(tx, stranger, first.opened[0]!.id, at(27)), 'NOT_FOUND')
      expect(await dismissHubOpenedNotice(tx, student, first.opened[0]!.id, at(27))).toEqual({ dismissed: true })
      expect(await dismissHubOpenedNotice(tx, student, first.opened[0]!.id, at(28))).toEqual({ dismissed: true })
      expect((await listMyHubNotices(tx, student, at(29))).opened).toEqual([])
      expect(await listMyHubNotices(tx, stranger, at(29))).toEqual({ opened: [], noteRequests: [] })
    })
  })

  it('students who finished the course (past-term registration or past-term project member) get a senior-note request until they write one or dismiss it', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      const past = { userId: (await createUser(tx)).id }
      const member = { userId: (await createUser(tx)).id }
      const current = { userId: (await createUser(tx)).id }
      await verifiedAffiliation(tx, past.userId, schoolId)
      // 끝난 학기(2025년 2학기)의 등록: 등록 화면은 지금·다음 학기만 받으므로 행을 직접 넣습니다.
      await tx.insert(courseRegistrations).values({ userId: past.userId, courseTermId: term.id, createdAt: T0 })
      // 끝난 학기 과제 공간의 멤버.
      await createProject(tx, member, { title: '지난 학기 과제', courseTermId: term.id }, T0)
      // 진행 중인 학기만 등록한 학생은 아직 마치지 않았습니다.
      await registerCourse(tx, current, { courseId: course.id, year: 2026, semester: 'fall' }, T0)

      expect((await getMyHubOpening(tx, past, course.id, at(10))).finished).toBe(true)
      expect((await getMyHubOpening(tx, member, course.id, at(10))).finished).toBe(true)
      expect((await getMyHubOpening(tx, current, course.id, at(10))).finished).toBe(false)
      expect((await listMyHubNotices(tx, current, at(10))).noteRequests).toEqual([])
      const memberNotices = await listMyHubNotices(tx, member, at(10))
      expect(memberNotices.noteRequests).toEqual([{ course: expect.objectContaining({ id: course.id, title: course.title }), count: 0, threshold: 3 }])

      // E-01 학기 종료 알림이 떠 있으면 같은 요청이라 겹쳐 보여 주지 않습니다. 닫으면 E-02 요청이 보입니다.
      await tx.update(courseRegistrations).set({ postTermPromptedAt: T0 }).where(eq(courseRegistrations.userId, past.userId))
      expect((await listMyHubNotices(tx, past, at(10))).noteRequests).toEqual([])
      await tx.update(courseRegistrations).set({ promptDismissedAt: T0 }).where(eq(courseRegistrations.userId, past.userId))
      expect((await listMyHubNotices(tx, past, at(10))).noteRequests).toHaveLength(1)

      // 노트(초안 포함)를 쓰면 사라집니다.
      await createSeniorNote(tx, past, course.id, NOTE_INPUT, at(11))
      expect((await listMyHubNotices(tx, past, at(12))).noteRequests).toEqual([])
      expect((await getMyHubOpening(tx, past, course.id, at(12))).wroteNote).toBe(true)

      // 닫으면 사라집니다(멱등).
      expect(await dismissHubNoteRequest(tx, member, course.id, at(13))).toEqual({ dismissed: true })
      expect(await dismissHubNoteRequest(tx, member, course.id, at(14))).toEqual({ dismissed: true })
      expect((await listMyHubNotices(tx, member, at(15))).noteRequests).toEqual([])
      const rows = await tx
        .select()
        .from(courseHubNotices)
        .where(and(eq(courseHubNotices.userId, member.userId), eq(courseHubNotices.kind, 'note_request')))
      expect(rows).toHaveLength(1)
    })
  })

  it('operators see per-course progress (public item counts vs threshold) only; non-operators get 403', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const op = await createUser(tx)
      await tx.insert(operators).values({ userId: op.id })
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      await verifiedAffiliation(tx, owner.id, schoolId)
      await publishCase(tx, owner.id, term.id)
      await publishNote(tx, owner.id, course.id)
      const student = { userId: (await createUser(tx)).id }
      await registerCourse(tx, student, { courseId: course.id, year: 2026, semester: 'fall' }, T0)
      await requestHubOpenNotify(tx, student, course.id, at(10))

      await expectServiceError(getHubOpeningProgress(tx, { userId: owner.id }, at(10)), 'FORBIDDEN', 'operator_only')
      const progress = await getHubOpeningProgress(tx, { userId: op.id }, at(10))
      expect(progress).toMatchObject({ stagedOpening: true, threshold: 3 })
      expect(progress.items.find((i) => i.course.id === course.id)).toEqual({
        course: { id: course.id, title: course.title, code: course.code, schoolName: expect.any(String) },
        cases: 1,
        notes: 1,
        total: 2,
        status: 'preparing',
      })
      const json = JSON.stringify(progress)
      for (const leak of [student.userId, owner.id, 'notify', 'request']) expect(json).not.toContain(leak)
    })
  })
})
