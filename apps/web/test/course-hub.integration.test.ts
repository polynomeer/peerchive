/**
 * T-13 과목 허브·선배 노트·유용성 신호·플랜 포크·검색 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교·과목(무작위 이름)과 공개만 봅니다(개발 DB에 남은 행과 무관).
 * 검색 문서는 worker가 만드는 파생 데이터이므로 여기서는 같은 도메인 함수로 직접 넣고(worker handler 자체는 apps/worker 테스트),
 * "정리 handler가 아직 돌지 않아 문서·신호 행이 남아 있어도 공개 읽기에는 나오지 않음"을 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import { type HubSnapshot, searchDocFromSeniorNote, searchDocsFromSnapshot } from '@peerchive/domain'
import {
  and,
  artifacts,
  auditEvents,
  eq,
  logEntries,
  milestones,
  operators,
  outboxEvents,
  planForks,
  projectMembers,
  projects,
  publicationCandidates,
  publications,
  roleClaims,
  searchDocuments,
  seniorNotes,
  tasks,
  sql,
  usefulnessSignals,
  weeklyCheckins,
  type DbExecutor,
} from '@peerchive/db'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { mergeCourse } from '../server/modules/catalog/merge'
import { addCourseTag } from '../server/modules/catalog/tags'
import { forkPublication } from '../server/modules/course-hub/fork'
import { WORKLOAD_INSUFFICIENT_MESSAGE, getPublicCourseHub } from '../server/modules/course-hub/hub'
import { createPublicCourseHubHandler, createPublicSearchHandler } from '../server/modules/course-hub/public-http'
import { searchPublic } from '../server/modules/course-hub/search'
import {
  createSeniorNote,
  listMySeniorNotes,
  publishSeniorNote,
  updateSeniorNote,
  withdrawSeniorNote,
} from '../server/modules/course-hub/senior-notes'
import { deleteSignal, listMySignals, putSignal } from '../server/modules/course-hub/signals'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { createLog, reviseLog } from '../server/modules/logs/logs'
import { createMilestone } from '../server/modules/milestones/milestones'
import { createProject, getProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { createPublicKillSwitch, isAnonymousPublicRequest, isPublicPagePath } from '../server/modules/publication/public-http'
import { getPublicPublication } from '../server/modules/publication/public-read'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const SENTINEL = 'ZZSENTINELZZ'
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const slug = () => `case-${crypto.randomUUID().slice(0, 8)}`

async function courseFixture(db: DbExecutor, userId: string, schoolId?: string) {
  const t = token()
  const school = schoolId ? { id: schoolId } : await createSchool(db, { userId }, { name: `허브대${t}학교`, confirmNew: true }, T0)
  const course = await createCourse(db, { userId }, school.id, { title: `운영체제${t}`, code: `OS-${t}`, confirmNew: true }, T0)
  // 2025년 2학기: 이미 끝난 학기(엠바고 없음).
  const { term } = await createCourseTerm(db, { userId }, course.id, { year: 2025, semester: 'fall' }, T0)
  return { schoolId: school.id, course, term }
}

interface CaseOptions {
  owner: string
  termId: string | null
  title?: string
  slug?: string
  withStuck?: boolean
}

/** 지난 학기 과목에 연결된 개인 과제를 만들고 막힘·해결·진행 로그와 마일스톤 둘을 담아 요약 공개로 게시합니다. */
async function publishCase(db: DbExecutor, options: CaseOptions) {
  const actor = { userId: options.owner }
  const project = await createProject(db, actor, { title: `비공개 작업 ${SENTINEL}`, courseTermId: options.termId }, T0)
  const m1 = await createMilestone(db, actor, project.id, { title: '기획', dueAt: '2025-09-01', note: `${SENTINEL} 메모` }, at(1))
  const m2 = await createMilestone(db, actor, project.id, { title: '중간발표', dueAt: '2025-10-15' }, at(1))
  const logIds: string[] = []
  let stuckId: string | null = null
  if (options.withStuck !== false) {
    const stuck = (
      await createLog(
        db,
        actor,
        project.id,
        {
          tag: 'stuck',
          payload: { symptom: '좀비 프로세스가 남음', keywords: ['fork', 'waitpid'], attempts: [SENTINEL], timeBucket: 'half_day', answerCheck: true },
          links: [{ url: 'https://man7.org/wait', title: 'wait(2)' }],
        },
        at(2),
      )
    ).log
    const solution = (
      await createLog(
        db,
        actor,
        project.id,
        {
          tag: 'solution',
          payload: { method: `${SENTINEL} 해결 방법`, notAnswerConfirmed: true },
          resolvesEntryId: stuck.id,
          links: [{ url: 'https://answers.test/solution', title: '해결 링크' }],
        },
        at(3),
      )
    ).log
    stuckId = stuck.id
    logIds.push(stuck.id, solution.id)
  }
  const progress = (
    await createLog(db, actor, project.id, { tag: 'progress', body: `파서 완성 ${SENTINEL}`, links: [{ url: 'https://docs.test/ref', title: '참고 문서' }] }, at(4))
  ).log
  logIds.push(progress.id)
  const candidate = await createCandidate(
    db,
    actor,
    project.id,
    {
      level: 'summary',
      title: options.title ?? '셸 구현 과제',
      summary: '파이프와 리다이렉션을 구현했다.',
      slug: options.slug ?? slug(),
      logIds,
      milestoneIds: [m1.id, m2.id],
      exposure: { [options.owner]: 'name' },
      consentSelf: true,
    },
    at(5),
    ORIGINS,
  )
  expect(candidate.status).toBe('ready')
  const result = await publishCandidate(db, actor, candidate.id, { manifestHash: candidate.manifestHash }, at(6))
  return { project, candidate, publication: result.publication, stuckId, progressId: progress.id, milestoneIds: [m1.id, m2.id] }
}

/** worker의 검색 색인 handler와 같은 일을 직접 합니다(지금 release 스냅샷 → 문서). */
async function indexRelease(db: DbExecutor, publicationId: string) {
  const [row] = await db
    .select({ release: publicationCandidates })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .where(eq(publications.id, publicationId))
  for (const doc of searchDocsFromSnapshot(row!.release.snapshot as unknown as HubSnapshot)) {
    await db.insert(searchDocuments).values({ ...doc, publicationId, releaseId: row!.release.id })
  }
}

async function indexNote(db: DbExecutor, noteId: string) {
  const [note] = await db.select().from(seniorNotes).where(eq(seniorNotes.id, noteId))
  await db.insert(searchDocuments).values({
    kind: 'note',
    seniorNoteId: note!.id,
    noteVersion: note!.version,
    ...searchDocFromSeniorNote({ answers: note!.answers, termLabel: note!.termLabel }),
  })
}

const NOTE_INPUT = {
  displayMode: 'anonymous',
  termLabel: '2025년 2학기',
  totalTimeBucket: 'lt40h',
  answers: { firstWeek: '과제 명세를 끝까지 읽기', timeSink: '파이프 디버깅에 오래 걸림', wishKnew: '시그널 처리 개념' },
  noAnswersConfirmed: true,
}

describe('public path rules (T-13)', () => {
  it('treats course hub and search pages as public pages; only GET/HEAD under /api/v1/public skip the session', () => {
    expect(isPublicPagePath('/c/123')).toBe(true)
    expect(isPublicPagePath('/search')).toBe(true)
    expect(isPublicPagePath('/search?q=fork')).toBe(true)
    expect(isPublicPagePath('/consents')).toBe(false)
    expect(isPublicPagePath('/courses/1')).toBe(false)
    expect(isAnonymousPublicRequest('GET', '/api/v1/public/courses/1')).toBe(true)
    expect(isAnonymousPublicRequest('HEAD', '/api/v1/public/search')).toBe(true)
    expect(isAnonymousPublicRequest('POST', '/api/v1/public/publications/x/fork')).toBe(false)
    expect(isAnonymousPublicRequest('GET', '/api/v1/courses/1/senior-notes')).toBe(false)
  })
})

describe.skipIf(!databaseUrl)('course hub (PostgreSQL)', () => {
  afterAll(async () => {
    await closeTestDb()
  })

  it('lists only current published releases: draft/ready/withdrawn/replaced/embargoed/other-course excluded; stuck cards from the snapshot only', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx, { displayName: '김소유' })
      const actor = { userId: owner.id }
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      const other = await courseFixture(tx, owner.id)

      const live = await publishCase(tx, { owner: owner.id, termId: term.id, title: '공개 중 사례' })
      // 준비만 된 후보(게시 전).
      const readyProject = await createProject(tx, actor, { title: 'ready', courseTermId: term.id }, T0)
      const ready = await createCandidate(
        tx,
        actor,
        readyProject.id,
        { level: 'summary', title: '준비만 된 사례', summary: 's', slug: slug(), consentSelf: true },
        at(5),
        ORIGINS,
      )
      expect(ready.status).toBe('ready')
      // 철회된 사례.
      const withdrawn = await publishCase(tx, { owner: owner.id, termId: term.id, title: '철회된 사례' })
      await withdrawPublication(tx, actor, withdrawn.publication.id, {}, at(7))
      // v1 → v2(대체): v2에는 막힘이 없습니다.
      const replaced = await publishCase(tx, { owner: owner.id, termId: term.id, title: '첫 버전 제목' })
      const v2 = await createCandidate(
        tx,
        actor,
        replaced.project.id,
        {
          level: 'summary',
          title: '둘째 버전 제목',
          summary: 's',
          slug: replaced.publication.slug,
          logIds: [replaced.progressId],
          exposure: { [owner.id]: 'name' },
          consentSelf: true,
        },
        at(8),
        ORIGINS,
      )
      await publishCandidate(tx, actor, v2.id, { manifestHash: v2.manifestHash }, at(9))
      // 게시 뒤 엠바고가 걸린 사례.
      const embargoed = await publishCase(tx, { owner: owner.id, termId: term.id, title: '엠바고 사례' })
      await addProjectEmbargo(tx, actor, embargoed.project.id, { until: '2027-06-01T00:00:00Z', reason: '재수강' }, at(10))
      // 다른 과목의 사례.
      await publishCase(tx, { owner: owner.id, termId: other.term.id, title: '다른 과목 사례' })
      // 과목이 없는 사례(스냅샷에 과목 없음)는 어디에도 연결되지 않습니다.
      const noCourse = await publishCase(tx, { owner: owner.id, termId: null, title: '과목 없는 사례' })
      const [noCourseRelease] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.publicationId, noCourse.publication.id))
      expect(noCourseRelease).toMatchObject({ courseId: null, termLabel: null })

      // 게시 뒤 비공개 로그를 고쳐도 허브는 저장된 스냅샷을 씁니다.
      await reviseLog(
        tx,
        actor,
        live.stuckId,
        { expectedRevision: 1, payload: { symptom: `고친 증상 ${SENTINEL}`, keywords: [], timeBucket: 'lt2h', answerCheck: true } },
        at(11),
      )

      const hub = await getPublicCourseHub(tx, course.id, at(12))
      expect(hub.course).toMatchObject({ id: course.id, title: course.title, code: course.code, authoredBy: 'student' })
      expect(hub.cases.map((c) => c.title)).toEqual(['둘째 버전 제목', '공개 중 사례'])
      expect(hub.cases[1]).toMatchObject({
        slug: live.publication.slug,
        path: `/p/${live.publication.slug}`,
        termLabel: '2025년 2학기',
        level: 'summary',
        kind: 'individual',
        teamSize: null,
        milestoneCount: 2,
        stuckCount: 1,
        retrospective: false,
        forkCount: 0,
      })
      expect(hub.stuckItems).toHaveLength(1)
      expect(hub.stuckItems[0]).toMatchObject({
        slug: live.publication.slug,
        caseTitle: '공개 중 사례',
        symptom: '좀비 프로세스가 남음',
        keywords: ['fork', 'waitpid'],
        timeBucket: 'half_day',
        resolved: true,
        signals: { meToo: 0, helped: 0 },
      })
      expect(hub.stuckItems[0]!.path).toBe(`/p/${live.publication.slug}#public-${hub.stuckItems[0]!.key}`)
      // 비공개 내용·해결 내용·이메일·사용자 id·교수 필드는 없습니다.
      const json = JSON.stringify(hub)
      for (const leak of [SENTINEL, owner.email, owner.id, '해결 방법', 'professor', 'instructor']) expect(json).not.toContain(leak)
      expect(hub.workload).toEqual({ stats: null, minGroup: 5, message: WORKLOAD_INSUFFICIENT_MESSAGE })

      // 엠바고가 풀리면(시간이 지나면) 다시 보입니다. 다른 과목 허브에는 이 과목 사례가 없습니다.
      expect((await getPublicCourseHub(tx, course.id, new Date('2027-07-01T00:00:00Z'))).cases.map((c) => c.title)).toContain('엠바고 사례')
      expect((await getPublicCourseHub(tx, other.course.id, at(12))).cases.map((c) => c.title)).toEqual(['다른 과목 사례'])
      await expectServiceError(getPublicCourseHub(tx, crypto.randomUUID(), at(12)), 'NOT_FOUND')
      await expectServiceError(getPublicCourseHub(tx, 'not-a-uuid', at(12)), 'NOT_FOUND')

      // 공개 사례 응답에도 과목 허브 id와 포크 수가 실립니다.
      expect(await getPublicPublication(tx, live.publication.slug, at(12))).toMatchObject({ courseId: course.id, forkCount: 0 })

      // "다른 학교에서는": 같은 개념 태그를 가진 다른 학교 과목만(같은 학교 과목은 제외).
      const tagLabel = `파이프${token()}`
      const { tag } = await addCourseTag(tx, actor, course.id, { label: tagLabel }, T0)
      await addCourseTag(tx, actor, other.course.id, { tagId: tag.id }, T0)
      const sameSchool = await courseFixture(tx, owner.id, schoolId)
      await addCourseTag(tx, actor, sameSchool.course.id, { tagId: tag.id }, T0)
      const withTags = await getPublicCourseHub(tx, course.id, at(12))
      expect(withTags.conceptTags.map((t) => t.id)).toEqual([tag.id])
      expect(withTags.otherSchools.map((c) => [c.id, c.sharedTags.map((t) => t.id)])).toEqual([[other.course.id, [tag.id]]])
    })
  })

  it('resolves merged course ids to the canonical hub and rehomes releases and notes on merge', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const operator = await createUser(tx)
      await tx.insert(operators).values({ userId: operator.id })
      const a = await courseFixture(tx, owner.id)
      const b = await courseFixture(tx, owner.id, a.schoolId)
      await verifiedAffiliation(tx, owner.id, a.schoolId)
      const caseB = await publishCase(tx, { owner: owner.id, termId: b.term.id, title: '병합될 과목 사례' })
      const note = await createSeniorNote(tx, { userId: owner.id }, b.course.id, NOTE_INPUT, at(7))
      await publishSeniorNote(tx, { userId: owner.id }, note.id, { expectedVersion: 1 }, at(8))

      await mergeCourse(tx, { userId: operator.id }, b.course.id, { into: a.course.id }, at(9))
      const [release] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.publicationId, caseB.publication.id))
      expect(release!.courseId).toBe(a.course.id)
      const [noteRow] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, note.id))
      expect(noteRow!.courseId).toBe(a.course.id)
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'course.merge'), eq(auditEvents.targetId, b.course.id)))
      expect(audit!.metadata).toMatchObject({ releasesRehomed: 1, seniorNotesRehomed: 1 })

      const viaMerged = await getPublicCourseHub(tx, b.course.id, at(10))
      expect(viaMerged.course.id).toBe(a.course.id)
      expect(viaMerged.cases.map((c) => c.title)).toEqual(['병합될 과목 사례'])
      expect(viaMerged.seniorNotes.map((n) => n.id)).toEqual([note.id])
      expect(await getPublicPublication(tx, caseB.publication.slug, at(10))).toMatchObject({ courseId: a.course.id })

      // 병합 전에 남은 행이 원본 id를 가리키고 있어도(정리 전) 정본 허브에 모입니다.
      await tx.update(publicationCandidates).set({ courseId: b.course.id }).where(eq(publicationCandidates.id, release!.id))
      expect((await getPublicCourseHub(tx, a.course.id, at(10))).cases).toHaveLength(1)
    })
  })

  it('workload distribution: null below 5 contributors, present at ≥5, only share_for_stats rows', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const { course, term } = await courseFixture(tx, owner.id)
      const project = await createProject(tx, { userId: owner.id }, { title: 'p', courseTermId: term.id }, T0)
      const otherCourse = await courseFixture(tx, owner.id)
      const otherProject = await createProject(tx, { userId: owner.id }, { title: 'q', courseTermId: otherCourse.term.id }, T0)
      const addCheckin = async (projectId: string, share: boolean, bucket: 'lt5h' | 'lt10h' = 'lt5h') => {
        const user = await createUser(tx)
        await tx.insert(weeklyCheckins).values({ projectId, userId: user.id, isoWeek: '2025-W40', timeBucket: bucket, difficulty: 3, shareForStats: share })
        return user.id
      }
      for (let i = 0; i < 4; i++) await addCheckin(project.id, true)
      // 동의하지 않은 체크인과 다른 과목 체크인은 세지 않습니다.
      for (let i = 0; i < 3; i++) await addCheckin(project.id, false)
      for (let i = 0; i < 3; i++) await addCheckin(otherProject.id, true)
      expect((await getPublicCourseHub(tx, course.id, at(1))).workload).toEqual({ stats: null, minGroup: 5, message: '아직 데이터가 충분하지 않음' })

      const fifth = await addCheckin(project.id, true, 'lt10h')
      // 같은 사람이 여러 주를 내도 사람 수는 하나입니다.
      await tx.insert(weeklyCheckins).values({ projectId: project.id, userId: fifth, isoWeek: '2025-W41', timeBucket: 'lt10h', difficulty: 5, shareForStats: true })
      const { workload } = await getPublicCourseHub(tx, course.id, at(1))
      expect(workload.message).toBeNull()
      expect(workload.stats).toEqual({
        contributors: 5,
        timeBuckets: { none: 0, lt2h: 0, lt5h: 4, lt10h: 2, ten_plus: 0 },
        difficulty: { '1': 0, '2': 0, '3': 5, '4': 0, '5': 1 },
      })
      expect(JSON.stringify(workload)).not.toContain(fifth)
    })
  })

  it('senior notes: validation, draft private, checks need confirmation, anonymous label, edit unpublishes, immediate withdraw', async () => {
    await withRollback(async (tx) => {
      const author = await createUser(tx, { displayName: '박선배' })
      const stranger = await createUser(tx)
      const suspended = await createUser(tx, { status: 'suspended' })
      const { course, schoolId } = await courseFixture(tx, author.id)
      await verifiedAffiliation(tx, author.id, schoolId)
      await verifiedAffiliation(tx, suspended.id, schoolId)
      const actor = { userId: author.id }

      const confirmMissing = await expectServiceError(createSeniorNote(tx, actor, course.id, { ...NOTE_INPUT, noAnswersConfirmed: false }, at(1)), 'VALIDATION')
      expect(confirmMissing.fields).toEqual({ noAnswersConfirmed: 'confirm_required' })
      const tooFew = await expectServiceError(createSeniorNote(tx, actor, course.id, { ...NOTE_INPUT, answers: { firstWeek: '하나만' } }, at(1)), 'VALIDATION')
      expect(tooFew.fields).toEqual({ answers: 'too_few' })
      const tooLong = await expectServiceError(
        createSeniorNote(tx, actor, course.id, { ...NOTE_INPUT, answers: { firstWeek: 'a'.repeat(1001), timeSink: 'b' } }, at(1)),
        'VALIDATION',
      )
      expect(tooLong.fields).toEqual({ 'answers.firstWeek': 'too_long' })
      const noName = await expectServiceError(createSeniorNote(tx, actor, course.id, { ...NOTE_INPUT, displayMode: 'display' }, at(1)), 'VALIDATION')
      expect(noName.fields).toEqual({ displayName: 'required' })
      await expectServiceError(createSeniorNote(tx, actor, crypto.randomUUID(), NOTE_INPUT, at(1)), 'NOT_FOUND')
      await expectServiceError(createSeniorNote(tx, { userId: suspended.id }, course.id, NOTE_INPUT, at(1)), 'FORBIDDEN', 'hub_write_not_allowed')

      const draft = await createSeniorNote(
        tx,
        actor,
        course.id,
        { ...NOTE_INPUT, answers: { ...NOTE_INPUT.answers, differently: '조교에게 010-1234-5678로 연락' } },
        at(2),
      )
      expect(draft).toMatchObject({ status: 'draft', version: 1, displayMode: 'anonymous', displayName: null, publicLabel: '익명 선배' })
      expect(draft.warnings.map((w) => [w.rule, w.location.field])).toEqual([['phone', 'answers.differently']])
      // 초안은 공개되지 않고, 남은 작성자만 고치거나 게시할 수 있습니다.
      expect((await getPublicCourseHub(tx, course.id, at(3))).seniorNotes).toEqual([])
      await expectServiceError(updateSeniorNote(tx, { userId: stranger.id }, draft.id, { expectedVersion: 1, termLabel: 'x' }, at(3)), 'NOT_FOUND')
      await expectServiceError(publishSeniorNote(tx, { userId: stranger.id }, draft.id, { expectedVersion: 1 }, at(3)), 'NOT_FOUND')
      await expectServiceError(withdrawSeniorNote(tx, actor, draft.id, at(3)), 'CONFLICT', 'not_published')

      // 경고를 확인하지 않으면 409 + 가린 표본.
      const unconfirmed = await expectServiceError(publishSeniorNote(tx, actor, draft.id, { expectedVersion: 1 }, at(4)), 'CONFLICT', 'checks_unconfirmed')
      expect(unconfirmed.details).toEqual({ warnings: [{ rule: 'phone', field: 'answers.differently', sample: expect.stringContaining('*') }] })
      expect(JSON.stringify(unconfirmed.details)).not.toContain('1234-5678')
      await expectServiceError(publishSeniorNote(tx, actor, draft.id, { expectedVersion: 2, confirmWarnings: true }, at(4)), 'CONFLICT', 'version_conflict')
      const published = await publishSeniorNote(tx, actor, draft.id, { expectedVersion: 1, confirmWarnings: true }, at(4))
      expect(published).toMatchObject({ status: 'published', publishedAt: at(4).toISOString() })
      // 재요청은 그대로 200.
      await expect(publishSeniorNote(tx, actor, draft.id, { expectedVersion: 1 }, at(4))).resolves.toMatchObject({ status: 'published' })

      const hub = await getPublicCourseHub(tx, course.id, at(5))
      expect(hub.seniorNotes).toEqual([
        {
          id: draft.id,
          author: '익명 선배',
          anonymous: true,
          termLabel: '2025년 2학기',
          totalTimeBucket: 'lt40h',
          answers: published.answers,
          publishedAt: at(4).toISOString(),
          signals: { meToo: 0, helped: 0 },
        },
      ])
      const json = JSON.stringify(hub)
      for (const leak of [author.id, author.email, '박선배']) expect(json).not.toContain(leak)
      // 운영자는 감사 기록으로만 작성자를 압니다.
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'senior_note.publish'), eq(auditEvents.targetId, draft.id)))
      expect(audit!.actorId).toBe(author.id)
      const [publishedEvent] = await tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.topic, 'senior_note.published'), eq(outboxEvents.payload, { seniorNoteId: draft.id, courseId: course.id, version: 1 })))
      expect(publishedEvent).toBeTruthy()

      // 게시된 노트를 고치면 draft로 돌아가 공개에서 바로 내려갑니다(다시 게시 필요). 이름 표시로 바꾸면 계정 이름.
      const edited = await updateSeniorNote(tx, actor, draft.id, { expectedVersion: 1, displayMode: 'name' }, at(6))
      expect(edited).toMatchObject({ status: 'draft', version: 2, displayName: '박선배', publicLabel: '박선배' })
      expect((await getPublicCourseHub(tx, course.id, at(7))).seniorNotes).toEqual([])
      await expectServiceError(updateSeniorNote(tx, actor, draft.id, { expectedVersion: 1, termLabel: 'x' }, at(7)), 'CONFLICT', 'version_conflict')
      await publishSeniorNote(tx, actor, draft.id, { expectedVersion: 2, confirmWarnings: true }, at(8))
      expect((await getPublicCourseHub(tx, course.id, at(9))).seniorNotes.map((n) => [n.author, n.anonymous])).toEqual([['박선배', false]])

      // 철회는 즉시(worker 없이) 사라집니다. 이미 철회면 그대로 200.
      await withdrawSeniorNote(tx, actor, draft.id, at(10))
      expect((await getPublicCourseHub(tx, course.id, at(10))).seniorNotes).toEqual([])
      await expect(withdrawSeniorNote(tx, actor, draft.id, at(11))).resolves.toMatchObject({ status: 'withdrawn' })
      const withdrawnEvents = await tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.topic, 'senior_note.withdrawn'), sql`${outboxEvents.payload}->>'seniorNoteId' = ${draft.id}`))
      expect(withdrawnEvents).toHaveLength(2) // 고쳐서 내려감 + 철회

      // 숨김(운영자 조치) 노트는 고칠 수도, 게시할 수도 없습니다.
      await tx.update(seniorNotes).set({ status: 'hidden' }).where(eq(seniorNotes.id, draft.id))
      await expectServiceError(publishSeniorNote(tx, actor, draft.id, { expectedVersion: 2 }, at(12)), 'CONFLICT', 'hidden')
      expect((await listMySeniorNotes(tx, actor, course.id)).map((n) => n.status)).toEqual(['hidden'])

      // 과목당 3개 한도(숨김 제외).
      for (let i = 0; i < 3; i++) await createSeniorNote(tx, actor, course.id, NOTE_INPUT, at(13 + i))
      await expectServiceError(createSeniorNote(tx, actor, course.id, NOTE_INPUT, at(20)), 'CONFLICT', 'limit_reached')
    })
  })

  it('usefulness signals: unique per user/target/kind, only on currently public targets, ignored once withdrawn', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const reader = await createUser(tx)
      const reader2 = await createUser(tx)
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      await verifiedAffiliation(tx, owner.id, schoolId)
      const live = await publishCase(tx, { owner: owner.id, termId: term.id })
      const hub = await getPublicCourseHub(tx, course.id, at(10))
      const key = hub.stuckItems[0]!.key
      const target = { kind: 'stuck_item', slug: live.publication.slug, itemKey: key }

      expect(await putSignal(tx, { userId: reader.id }, { target, kind: 'me_too' }, at(11))).toEqual({
        signals: { meToo: 1, helped: 0 },
        mine: { meToo: true, helped: false },
      })
      // 같은 신호를 다시 남겨도 하나.
      await putSignal(tx, { userId: reader.id }, { target, kind: 'me_too' }, at(11))
      await putSignal(tx, { userId: reader2.id }, { target, kind: 'me_too' }, at(11))
      expect(await putSignal(tx, { userId: reader2.id }, { target, kind: 'helped' }, at(11))).toEqual({
        signals: { meToo: 2, helped: 1 },
        mine: { meToo: true, helped: true },
      })
      expect(await deleteSignal(tx, { userId: reader.id }, { target, kind: 'me_too' }, at(12))).toEqual({
        signals: { meToo: 1, helped: 1 },
        mine: { meToo: false, helped: false },
      })
      expect((await getPublicCourseHub(tx, course.id, at(12))).stuckItems[0]!.signals).toEqual({ meToo: 1, helped: 1 })
      expect(await listMySignals(tx, { userId: reader2.id }, at(12))).toEqual(
        expect.arrayContaining([
          { target: 'stuck_item', slug: live.publication.slug, itemKey: key, kind: 'me_too' },
          { target: 'stuck_item', slug: live.publication.slug, itemKey: key, kind: 'helped' },
        ]),
      )

      // 지금 공개가 아닌 대상·없는 키·풀 수 없는 종류.
      await expectServiceError(putSignal(tx, { userId: reader.id }, { target: { ...target, itemKey: 'l_nope' }, kind: 'me_too' }, at(12)), 'NOT_FOUND')
      await expectServiceError(putSignal(tx, { userId: reader.id }, { target: { ...target, slug: 'no-such-case' }, kind: 'me_too' }, at(12)), 'NOT_FOUND')
      const note = await createSeniorNote(tx, { userId: owner.id }, course.id, NOTE_INPUT, at(12))
      await expectServiceError(putSignal(tx, { userId: reader.id }, { target: { kind: 'senior_note', noteId: note.id }, kind: 'helped' }, at(12)), 'NOT_FOUND')
      await publishSeniorNote(tx, { userId: owner.id }, note.id, { expectedVersion: 1 }, at(13))
      const badKind = await expectServiceError(
        putSignal(tx, { userId: reader.id }, { target: { kind: 'senior_note', noteId: note.id }, kind: 'me_too' }, at(13)),
        'VALIDATION',
      )
      expect(badKind.fields).toEqual({ kind: 'not_allowed' })
      await putSignal(tx, { userId: reader.id }, { target: { kind: 'senior_note', noteId: note.id }, kind: 'helped' }, at(13))
      expect((await getPublicCourseHub(tx, course.id, at(13))).seniorNotes[0]!.signals).toEqual({ meToo: 0, helped: 1 })

      // 철회 뒤: 정리 handler가 돌기 전이라 행은 남아 있지만, 읽기에는 대상도 신호도 나오지 않고 새 신호도 받지 않습니다.
      await withdrawPublication(tx, { userId: owner.id }, live.publication.id, {}, at(14))
      await withdrawSeniorNote(tx, { userId: owner.id }, note.id, at(14))
      const rows = await tx.select().from(usefulnessSignals).where(eq(usefulnessSignals.publicationId, live.publication.id))
      expect(rows).toHaveLength(2)
      const after = await getPublicCourseHub(tx, course.id, at(15))
      expect(after.stuckItems).toEqual([])
      expect(after.seniorNotes).toEqual([])
      expect(await listMySignals(tx, { userId: reader2.id }, at(15))).toEqual([])
      expect(await listMySignals(tx, { userId: reader.id }, at(15))).toEqual([])
      await expectServiceError(putSignal(tx, { userId: reader.id }, { target, kind: 'me_too' }, at(15)), 'NOT_FOUND')
      await expectServiceError(putSignal(tx, { userId: reader.id }, { target: { kind: 'senior_note', noteId: note.id }, kind: 'helped' }, at(15)), 'NOT_FOUND')
    })
  })

  it('plan fork copies only milestones and references into a new private project owned by the caller; fork count = distinct users', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx, { displayName: '김소유' })
      const junior = await createUser(tx)
      const junior2 = await createUser(tx)
      const { course, term } = await courseFixture(tx, owner.id)
      const live = await publishCase(tx, { owner: owner.id, termId: term.id, title: '셸 구현 과제' })

      const result = await forkPublication(tx, { userId: junior.id }, live.publication.slug, at(10))
      expect(result).toMatchObject({ created: true, copied: { milestones: 2, references: 2 }, projectPath: `/projects/${result.projectId}` })
      const project = await getProject(tx, { userId: junior.id }, result.projectId, at(10))
      expect(project).toMatchObject({
        title: '셸 구현 과제 계획 포크',
        visibility: 'private',
        myRole: 'owner',
        kind: 'individual',
        retroMode: false,
        courseTermId: null,
        goal: null,
        constraints: null,
      })
      expect(project.summaryByStudent).toBe('참고 자료(포크한 계획에서 가져옴):\n- wait(2) https://man7.org/wait\n- 참고 문서 https://docs.test/ref')
      const [row] = await tx.select().from(projects).where(eq(projects.id, result.projectId))
      expect(row!.ownerId).toBe(junior.id)
      const members = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, result.projectId))
      expect(members.map((m) => [m.userId, m.role, m.status])).toEqual([[junior.id, 'owner', 'active']])
      // 원작자는 새 프로젝트를 볼 수 없습니다.
      await expectServiceError(getProject(tx, { userId: owner.id }, result.projectId, at(10)), 'NOT_FOUND')

      const copiedMilestones = await tx.select().from(milestones).where(eq(milestones.projectId, result.projectId)).orderBy(milestones.position)
      expect(copiedMilestones.map((m) => [m.position, m.title, m.dueAt, m.claimedAt, m.note, m.retrospective, m.createdBy])).toEqual([
        [1, '기획', null, null, '원래 계획의 첫 예정일(기준)', false, junior.id],
        [2, '중간발표', null, null, '원래 계획에서 첫 예정일 기준 +44일', false, junior.id],
      ])
      // 로그·할 일·파일·역할 선언은 하나도 없습니다. 이름·비공개 메모·해결 내용도 복사되지 않습니다.
      for (const table of [logEntries, tasks, artifacts, roleClaims] as const) {
        expect(await tx.select().from(table).where(eq(table.projectId, result.projectId))).toEqual([])
      }
      const dump = JSON.stringify({ project, copiedMilestones })
      for (const leak of [SENTINEL, '김소유', 'answers.test', '좀비', owner.email]) expect(dump).not.toContain(leak)

      // 같은 사람이 다시 포크하면 기존 프로젝트(200). 다른 사람은 새로. 포크 수 = 서로 다른 사용자 수.
      expect(await forkPublication(tx, { userId: junior.id }, live.publication.slug, at(11))).toMatchObject({ created: false, projectId: result.projectId })
      await forkPublication(tx, { userId: junior2.id }, live.publication.slug, at(11))
      expect(await tx.select().from(planForks).where(eq(planForks.sourcePublicationId, live.publication.id))).toHaveLength(2)
      expect((await getPublicPublication(tx, live.publication.slug, at(12))).forkCount).toBe(2)
      expect((await getPublicCourseHub(tx, course.id, at(12))).cases[0]!.forkCount).toBe(2)
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'plan.fork'), eq(auditEvents.targetId, result.projectId)))
      expect(audit!.metadata).toMatchObject({ sourcePublicationId: live.publication.id, releaseNo: 1, milestones: 2, references: 2 })

      // 철회·없는 공개는 404. 이미 만든 포크는 포크한 사람의 데이터로 남습니다.
      await withdrawPublication(tx, { userId: owner.id }, live.publication.id, {}, at(13))
      const junior3 = await createUser(tx)
      await expectServiceError(forkPublication(tx, { userId: junior3.id }, live.publication.slug, at(14)), 'NOT_FOUND')
      await expectServiceError(forkPublication(tx, { userId: junior3.id }, 'no-such-case', at(14)), 'NOT_FOUND')
      await expect(getProject(tx, { userId: junior.id }, result.projectId, at(14))).resolves.toBeTruthy()
    })
  })

  it('fork is rate limited per user', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const junior = await createUser(tx)
      const { term } = await courseFixture(tx, owner.id)
      const slugs: string[] = []
      for (let i = 0; i < 11; i++) slugs.push((await publishCase(tx, { owner: owner.id, termId: term.id, withStuck: false })).publication.slug)
      for (let i = 0; i < 10; i++) await forkPublication(tx, { userId: junior.id }, slugs[i], at(20))
      await expectServiceError(forkPublication(tx, { userId: junior.id }, slugs[10], at(20)), 'RATE_LIMITED')
    })
  })

  it('search returns only published content and excludes withdrawn/replaced/edited even while stale documents remain', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const t = token()
      const { course, term, schoolId } = await courseFixture(tx, owner.id)
      await verifiedAffiliation(tx, owner.id, schoolId)
      const other = await courseFixture(tx, owner.id)
      const live = await publishCase(tx, { owner: owner.id, termId: term.id, title: `파이프 셸 ${t}` })
      const otherCase = await publishCase(tx, { owner: owner.id, termId: other.term.id, title: `파이프 셸 ${t} 다른 과목` })
      await indexRelease(tx, live.publication.id)
      await indexRelease(tx, otherCase.publication.id)
      const note = await createSeniorNote(tx, { userId: owner.id }, course.id, { ...NOTE_INPUT, answers: { firstWeek: `좀비 ${t} 주의`, timeSink: '파이프' } }, at(7))
      await publishSeniorNote(tx, { userId: owner.id }, note.id, { expectedVersion: 1 }, at(8))
      await indexNote(tx, note.id)

      const all = await searchPublic(tx, { q: t }, at(9))
      expect(all.results.map((r) => [r.kind, r.title])).toEqual(
        expect.arrayContaining([
          ['case', `파이프 셸 ${t}`],
          ['case', `파이프 셸 ${t} 다른 과목`],
          ['note', '선배 노트 · 2025년 2학기'],
        ]),
      )
      expect(all.results).toHaveLength(3)
      const stuck = await searchPublic(tx, { q: '좀비 프로세스', type: 'stuck', course: course.id }, at(9))
      expect(stuck.results).toEqual([
        {
          kind: 'stuck',
          title: '좀비 프로세스가 남음',
          snippet: 'fork, waitpid',
          path: expect.stringMatching(new RegExp(`^/p/${live.publication.slug}#public-l_`)),
          course: { id: course.id, title: course.title, schoolName: expect.any(String) },
        },
      ])
      const byCourse = await searchPublic(tx, { q: t, type: 'case', course: course.id }, at(9))
      expect(byCourse.results.map((r) => r.path)).toEqual([`/p/${live.publication.slug}`])
      const notes = await searchPublic(tx, { q: t, type: 'note' }, at(9))
      expect(notes.results.map((r) => r.path)).toEqual([`/c/${course.id}#note-${note.id}`])
      // 비공개 내용(스냅샷의 시도·해결·진행 본문 포함)은 색인하지 않습니다.
      expect((await searchPublic(tx, { q: SENTINEL }, at(9))).results).toEqual([])
      expect((await searchPublic(tx, { q: '   ' }, at(9))).results).toEqual([])
      expect((await searchPublic(tx, { q: t, course: crypto.randomUUID() }, at(9))).results).toEqual([])
      expect((await expectServiceError(searchPublic(tx, { q: t, type: 'logs' }, at(9)), 'VALIDATION')).fields).toEqual({ type: 'invalid' })
      expect((await expectServiceError(searchPublic(tx, { q: 'x'.repeat(101) }, at(9)), 'VALIDATION')).fields).toEqual({ q: 'too_long' })

      // 게시된 노트를 고쳐 다시 게시하면, 옛 버전에서 만든 문서는 다시 색인되기 전까지 결과에 나오지 않습니다.
      await updateSeniorNote(tx, { userId: owner.id }, note.id, { expectedVersion: 1, termLabel: '2025년 겨울' }, at(9))
      await publishSeniorNote(tx, { userId: owner.id }, note.id, { expectedVersion: 2 }, at(9))
      expect((await searchPublic(tx, { q: t, type: 'note' }, at(9))).results).toEqual([])

      // 철회: 문서 행은 남아 있어도(정리 전) 결과에서 바로 빠집니다.
      await withdrawPublication(tx, { userId: owner.id }, otherCase.publication.id, {}, at(10))
      await withdrawSeniorNote(tx, { userId: owner.id }, note.id, at(10))
      expect(await tx.select().from(searchDocuments).where(eq(searchDocuments.publicationId, otherCase.publication.id))).not.toEqual([])
      expect(await tx.select().from(searchDocuments).where(eq(searchDocuments.seniorNoteId, note.id))).toHaveLength(1)
      expect((await searchPublic(tx, { q: t }, at(11))).results.map((r) => r.title)).toEqual([`파이프 셸 ${t}`])

      // 새 버전 게시(대체): 이전 release 문서가 남아 있어도 나오지 않습니다(새 release 문서는 아직 없음).
      const v2 = await createCandidate(
        tx,
        { userId: owner.id },
        live.project.id,
        { level: 'summary', title: `새 제목 ${t}`, summary: 's', slug: live.publication.slug, consentSelf: true },
        at(12),
        ORIGINS,
      )
      await publishCandidate(tx, { userId: owner.id }, v2.id, { manifestHash: v2.manifestHash }, at(13))
      expect((await searchPublic(tx, { q: t }, at(14))).results).toEqual([])
      await indexRelease(tx, live.publication.id)
      expect((await searchPublic(tx, { q: t }, at(14))).results.map((r) => r.title)).toEqual([`새 제목 ${t}`])

      // 엠바고가 걸리면 문서가 있어도 나오지 않습니다.
      await addProjectEmbargo(tx, { userId: owner.id }, live.project.id, { until: '2027-06-01T00:00:00Z', reason: '재수강' }, at(15))
      expect((await searchPublic(tx, { q: t }, at(16))).results).toEqual([])
    })
  })

  it('HTTP: anonymous course hub and search set no cookies, are no-store/noindex, 404/422 shapes, kill switch 503', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const { course, term } = await courseFixture(tx, owner.id)
      await publishCase(tx, { owner: owner.id, termId: term.id })
      const env: Record<string, string | undefined> = {}
      const deps = { getDb: () => tx, getEnv: () => env, now: () => at(10) }
      const router = createRouter()
        .get('/api/v1/public/courses/:id', createPublicCourseHubHandler(deps))
        .get('/api/v1/public/search', createPublicSearchHandler(deps))
      const app = createApp()
      app.use(createPublicKillSwitch(() => env))
      app.use(router)
      const handler = toWebHandler(app)
      const get = (path: string) => handler(new Request(`http://localhost:3000${path}`, { headers: { cookie: 'peerchive_session=whatever' } }))

      for (const path of [`/api/v1/public/courses/${course.id}`, '/api/v1/public/search?q=zz']) {
        const res = await get(path)
        expect(res.status).toBe(200)
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
        expect(res.headers.get('x-content-type-options')).toBe('nosniff')
        expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      }
      const body = (await (await get(`/api/v1/public/courses/${course.id}`)).json()) as { cases: unknown[] }
      expect(body.cases).toHaveLength(1)
      const missing = await get(`/api/v1/public/courses/${crypto.randomUUID()}`)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('set-cookie')).toBeNull()
      const bad = await get('/api/v1/public/search?q=a&type=logs')
      expect(bad.status).toBe(422)
      expect(((await bad.json()) as { data: unknown }).data).toEqual({ code: 'validation_failed', fields: { type: 'invalid' } })

      env.PEERCHIVE_PUBLIC_READS_DISABLED = '1'
      expect((await get(`/api/v1/public/courses/${course.id}`)).status).toBe(503)
      expect((await get('/api/v1/public/search?q=zz')).status).toBe(503)
    })
  })
})
