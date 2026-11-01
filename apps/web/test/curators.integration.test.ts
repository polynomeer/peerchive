/**
 * E-03 학생 큐레이터 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * - 지정·해제는 운영자만, 자격(과목을 마침 + 그 학교 active 학교 인증), 과목당 2명, 해제 즉시 권한 없음, 과목 병합 때 정본으로 옮김.
 * - 권한 표: 자기 과목에서만 병합 제안·과제 유형 요약·신고 의견·팀원 찾기 끄기. 다른 과목 403, 신고 처리·상세·작성자 확인은 운영자만.
 *   큐레이터가 보는 신고 묶음에는 신고자 id·신고 설명이 없고, 운영자 상세에는 큐레이터 의견이 보임(신고 상태는 그대로).
 * - 공개 프로필 "후배 기여"의 큐레이터 과목은 본인이 켰을 때만(기본 꺼짐), 해제되면 사라짐.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  and,
  auditEvents,
  conceptTags,
  courseCurators,
  courseRegistrations,
  courses,
  eq,
  operators,
  reports,
  type DbExecutor,
} from '@peerchive/db'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { mergeCourse } from '../server/modules/catalog/merge'
import { addCourseTag } from '../server/modules/catalog/tags'
import { setCourseTeamFindingAsCurator } from '../server/modules/community/recruitments'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { createSeniorNote, publishSeniorNote } from '../server/modules/course-hub/senior-notes'
import { curatedCourseIds, requireCourseCurator } from '../server/modules/curators/access'
import { grantCourseCurator, listAllCurators, listCourseCurators, revokeCourseCurator } from '../server/modules/curators/assignments'
import { listMyCuratedCourses, setCuratorPortfolioDisplay } from '../server/modules/curators/portfolio'
import { listCuratorReports, recommendOnReport } from '../server/modules/curators/report-review'
import { putAssignmentTypeSummary } from '../server/modules/curators/summaries'
import { approveTagMergeProposal, listTagMergeProposals, proposeTagMerge, rejectTagMergeProposal } from '../server/modules/curators/tag-proposals'
import { getCuratorWorkspace } from '../server/modules/curators/workspace'
import { createLog } from '../server/modules/logs/logs'
import { dismissReport, getReportDetail, listReportGroups, resolveReport } from '../server/modules/moderation/operator'
import { createReport } from '../server/modules/moderation/reports'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { publishCandidate } from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z') // 2026년 2학기 진행 중
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const DETAILS = '신고자만 아는 설명 문장'

const NOTE_INPUT = {
  displayMode: 'anonymous',
  termLabel: '2025년 2학기',
  totalTimeBucket: 'lt40h',
  answers: { firstWeek: '명세를 끝까지 읽기', timeSink: '디버깅에 오래 걸림', wishKnew: '시그널 개념' },
  noAnswersConfirmed: true,
}

/** 학교 하나에 과목 두 개(둘 다 2025년 2학기 — 이미 끝난 학기). */
async function fixture(db: DbExecutor) {
  const t = token()
  const op = await createUser(db, { displayName: '운영자' })
  await db.insert(operators).values({ userId: op.id })
  const school = await createSchool(db, { userId: op.id }, { name: `큐레이터대${t}학교`, confirmNew: true }, T0)
  const course = await createCourse(db, { userId: op.id }, school.id, { title: `운영체제${t}`, code: `OS-${t}`, confirmNew: true }, T0)
  const other = await createCourse(db, { userId: op.id }, school.id, { title: `컴파일러${t}`, code: `CC-${t}`, confirmNew: true }, T0)
  const { term } = await createCourseTerm(db, { userId: op.id }, course.id, { year: 2025, semester: 'fall' }, T0)
  const { term: otherTerm } = await createCourseTerm(db, { userId: op.id }, other.id, { year: 2025, semester: 'fall' }, T0)
  return { O: { userId: op.id }, schoolId: school.id, course, other, term, otherTerm, t }
}

/** 과목을 마친(끝난 학기 과제 공간의 멤버) + 학교 인증이 있는 사용자. */
async function finishedVerified(db: DbExecutor, schoolId: string, termId: string, handle?: string) {
  const u = await createUser(db, { displayName: '큐레이터 후보', handle })
  await createProject(db, { userId: u.id }, { title: '지난 학기 과제', courseTermId: termId }, T0)
  await verifiedAffiliation(db, u.id, schoolId, { standing: 'alumni' })
  return u
}

async function publishCase(db: DbExecutor, owner: string, termId: string) {
  const actor = { userId: owner }
  const project = await createProject(db, actor, { title: '공개할 과제', courseTermId: termId }, T0)
  const log = (await createLog(db, actor, project.id, { tag: 'progress', body: '진행 기록', links: [] }, at(1))).log
  const candidate = await createCandidate(
    db,
    actor,
    project.id,
    { level: 'summary', title: '공개 사례', summary: '요약', slug: `case-${crypto.randomUUID().slice(0, 8)}`, logIds: [log.id], milestoneIds: [], exposure: { [owner]: 'name' }, consentSelf: true },
    at(2),
    ORIGINS,
  )
  return (await publishCandidate(db, actor, candidate.id, { manifestHash: candidate.manifestHash }, at(3))).publication
}

describe.skipIf(!databaseUrl)('E-03 student curators (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('operators assign and remove curators (audited, ids only); eligibility is finished course + school verification; at most 2 per course', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const A = await finishedVerified(tx, f.schoolId, f.term.id)
      const B = await finishedVerified(tx, f.schoolId, f.term.id)
      const C = await finishedVerified(tx, f.schoolId, f.term.id)

      // 운영자만(대상 존재 여부보다 먼저).
      await expectServiceError(grantCourseCurator(tx, { userId: A.id }, f.course.id, { userId: B.id }, at(1)), 'FORBIDDEN', 'operator_only')
      await expectServiceError(listCourseCurators(tx, { userId: A.id }, 'nope'), 'FORBIDDEN', 'operator_only')
      await expectServiceError(listAllCurators(tx, { userId: A.id }), 'FORBIDDEN', 'operator_only')
      await expectServiceError(revokeCourseCurator(tx, { userId: A.id }, f.course.id, B.id, at(1)), 'FORBIDDEN', 'operator_only')

      // 자격: 마치지 않음 / 학교 인증 없음 / 다른 학교 인증 / 끝나지 않은 학기만 / 없는 사용자·비활성.
      const notFinished = await createUser(tx)
      await verifiedAffiliation(tx, notFinished.id, f.schoolId)
      expect((await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: notFinished.id }, at(1)), 'VALIDATION')).fields).toEqual({ userId: 'not_finished' })
      const notVerified = await createUser(tx)
      await createProject(tx, { userId: notVerified.id }, { title: '과제', courseTermId: f.term.id }, T0)
      expect((await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: notVerified.id }, at(1)), 'VALIDATION')).fields).toEqual({ userId: 'not_verified' })
      const otherSchool = await createSchool(tx, f.O, { name: `다른대${f.t}학교`, confirmNew: true }, T0)
      await verifiedAffiliation(tx, notVerified.id, otherSchool.id)
      expect((await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: notVerified.id }, at(1)), 'VALIDATION')).fields).toEqual({ userId: 'not_verified' })
      const current = await createUser(tx)
      const { term: thisTerm } = await createCourseTerm(tx, f.O, f.course.id, { year: 2026, semester: 'fall' }, T0)
      await createProject(tx, { userId: current.id }, { title: '이번 학기 과제', courseTermId: thisTerm.id }, T0)
      await verifiedAffiliation(tx, current.id, f.schoolId)
      expect((await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: current.id }, at(1)), 'VALIDATION')).fields).toEqual({ userId: 'not_finished' })
      expect((await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: crypto.randomUUID() }, at(1)), 'VALIDATION')).fields).toEqual({ userId: 'not_found' })
      const gone = await createUser(tx, { status: 'suspended' })
      expect((await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: gone.id }, at(1)), 'VALIDATION')).fields).toEqual({ userId: 'inactive' })
      // 지난 학기 등록(E-01)만 있어도 "마침"입니다.
      const registered = await createUser(tx)
      await tx.insert(courseRegistrations).values({ userId: registered.id, courseTermId: f.term.id })
      await verifiedAffiliation(tx, registered.id, f.schoolId)

      const list = await grantCourseCurator(tx, f.O, f.course.id, { userId: A.id }, at(2))
      expect(list).toEqual([{ id: expect.any(String), course: { id: f.course.id, title: f.course.title, code: f.course.code, schoolName: expect.any(String) }, userId: A.id, displayName: '큐레이터 후보', grantedAt: at(2).toISOString() }])
      await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: A.id }, at(3)), 'CONFLICT', 'already_curator')
      expect(await grantCourseCurator(tx, f.O, f.course.id, { userId: registered.id }, at(3))).toHaveLength(2)
      await expectServiceError(grantCourseCurator(tx, f.O, f.course.id, { userId: B.id }, at(4)), 'CONFLICT', 'limit_reached')
      // 다른 과목은 따로 셉니다(B는 다른 과목을 마치지 않았음 → 그 과목 기록이 필요).
      await createProject(tx, { userId: B.id }, { title: '다른 과목 과제', courseTermId: f.otherTerm.id }, T0)
      expect(await grantCourseCurator(tx, f.O, f.other.id, { userId: B.id }, at(4))).toHaveLength(1)
      expect((await listAllCurators(tx, f.O)).filter((c) => [f.course.id, f.other.id].includes(c.course.id))).toHaveLength(3)

      // 해제: 행은 남고, 자리가 비어 다시 지정할 수 있음. 큐레이터가 아니면 404.
      expect(await revokeCourseCurator(tx, f.O, f.course.id, registered.id, at(5))).toHaveLength(1)
      await expectServiceError(revokeCourseCurator(tx, f.O, f.course.id, registered.id, at(5)), 'NOT_FOUND')
      expect(await grantCourseCurator(tx, f.O, f.course.id, { userId: C.id }, at(6))).toHaveLength(2)
      expect(await tx.select().from(courseCurators).where(eq(courseCurators.userId, registered.id))).toMatchObject([{ revokedAt: at(5), revokedBy: f.O.userId }])

      // 감사: id만.
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetType, 'course_curator'), eq(auditEvents.actorId, f.O.userId)))
      expect(audits.map((a) => a.action).sort()).toEqual(['curator.grant', 'curator.grant', 'curator.grant', 'curator.grant', 'curator.revoke'])
      for (const a of audits) expect(Object.keys(a.metadata as object).sort()).toEqual(['courseId', 'userId'])
    })
  })

  it('capability matrix: own course only for summary, merge proposals and team finding; operators approve/reject merges; removal takes powers away at once', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const C = await finishedVerified(tx, f.schoolId, f.term.id)
      const stranger = await finishedVerified(tx, f.schoolId, f.term.id)
      await grantCourseCurator(tx, f.O, f.course.id, { userId: C.id }, at(1))
      const me = { userId: C.id }

      // 큐레이터가 아니면 403(과목이 없어도 먼저), 다른 과목도 403.
      await expectServiceError(getCuratorWorkspace(tx, { userId: stranger.id }, f.course.id), 'FORBIDDEN', 'curator_only')
      await expectServiceError(requireCourseCurator(tx, { userId: stranger.id }, 'no-such-course'), 'FORBIDDEN', 'curator_only')
      await expectServiceError(getCuratorWorkspace(tx, me, f.other.id), 'FORBIDDEN', 'curator_only')
      await expectServiceError(requireCourseCurator(tx, me, crypto.randomUUID()), 'NOT_FOUND')

      // 과제 유형 요약: 쓰기 → 허브에 공개(작성자 없음) → version 충돌 → 운영자도 고침 → 비우기.
      await expectServiceError(putAssignmentTypeSummary(tx, me, f.other.id, { body: 'x', expectedVersion: 0 }, at(2)), 'FORBIDDEN', 'curator_only')
      const s1 = await putAssignmentTypeSummary(tx, me, f.course.id, { body: '  개인 구현 과제 4개 + 팀 프로젝트 1개(셸·스케줄러·메모리)  ', expectedVersion: 0 }, at(2))
      expect(s1).toEqual({ body: '개인 구현 과제 4개 + 팀 프로젝트 1개(셸·스케줄러·메모리)', version: 1, updatedAt: at(2).toISOString() })
      expect((await getPublicCourseHub(tx, f.course.id, at(3))).assignmentTypeSummary).toEqual(s1)
      expect((await getPublicCourseHub(tx, f.other.id, at(3))).assignmentTypeSummary).toBeNull()
      expect(JSON.stringify(await getPublicCourseHub(tx, f.course.id, at(3)))).not.toContain(C.id)
      await expectServiceError(putAssignmentTypeSummary(tx, me, f.course.id, { body: '다른 글', expectedVersion: 0 }, at(3)), 'CONFLICT', 'version_conflict')
      expect((await expectServiceError(putAssignmentTypeSummary(tx, me, f.course.id, { body: 'x'.repeat(1001), expectedVersion: 1 }, at(3)), 'VALIDATION')).fields).toEqual({ body: 'too_long' })
      expect((await putAssignmentTypeSummary(tx, f.O, f.course.id, { body: '운영자가 고친 글', expectedVersion: 1 }, at(4)))?.version).toBe(2)
      expect(await putAssignmentTypeSummary(tx, me, f.course.id, { body: '', expectedVersion: 2 }, at(5))).toBeNull()
      expect((await getPublicCourseHub(tx, f.course.id, at(6))).assignmentTypeSummary).toBeNull()
      const summaryAudits = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'curator.summary_update'), eq(auditEvents.targetId, f.course.id)))
      expect(summaryAudits.map((a) => a.metadata)).toEqual(
        expect.arrayContaining([
          { version: 1, cleared: false, byOperator: false },
          { version: 2, cleared: false, byOperator: true },
          { version: null, cleared: true, byOperator: false },
        ]),
      )

      // 병합 제안: 그 과목에 붙은 정본 태그만 원본으로, 같은 제안은 하나, 운영자가 승인하면 기존 병합이 실행됨.
      const recursion = (await addCourseTag(tx, f.O, f.course.id, { label: `재귀${f.t}` }, T0)).tag
      const recursionFn = (await addCourseTag(tx, f.O, f.course.id, { label: `재귀함수${f.t}` }, T0)).tag
      const elsewhere = (await addCourseTag(tx, f.O, f.other.id, { label: `파싱${f.t}` }, T0)).tag
      await expectServiceError(proposeTagMerge(tx, me, f.other.id, { sourceTagId: elsewhere.id, targetTagId: recursion.id }, at(7)), 'FORBIDDEN', 'curator_only')
      expect((await expectServiceError(proposeTagMerge(tx, me, f.course.id, { sourceTagId: elsewhere.id, targetTagId: recursion.id }, at(7)), 'VALIDATION')).fields).toEqual({ sourceTagId: 'not_on_course' })
      expect((await expectServiceError(proposeTagMerge(tx, me, f.course.id, { sourceTagId: recursion.id, targetTagId: recursion.id }, at(7)), 'VALIDATION')).fields).toEqual({ targetTagId: 'self' })
      // 운영자는 제안하지 않고 직접 병합합니다(큐레이터 전용).
      await expectServiceError(proposeTagMerge(tx, f.O, f.course.id, { sourceTagId: recursionFn.id, targetTagId: recursion.id }, at(7)), 'FORBIDDEN', 'curator_only')
      const proposal = await proposeTagMerge(tx, me, f.course.id, { sourceTagId: recursionFn.id, targetTagId: recursion.id, note: '같은 개념' }, at(7))
      expect(proposal).toMatchObject({ status: 'pending', source: { id: recursionFn.id }, target: { id: recursion.id }, note: '같은 개념', mine: true })
      expect(proposal).not.toHaveProperty('proposer')
      await expectServiceError(proposeTagMerge(tx, me, f.course.id, { sourceTagId: recursionFn.id, targetTagId: recursion.id }, at(8)), 'CONFLICT', 'already_proposed')
      const second = await proposeTagMerge(tx, me, f.course.id, { sourceTagId: recursion.id, targetTagId: elsewhere.id }, at(8))
      // 큐레이터는 승인·거절·대기열을 못 봄.
      await expectServiceError(listTagMergeProposals(tx, me, {}), 'FORBIDDEN', 'operator_only')
      await expectServiceError(approveTagMergeProposal(tx, me, proposal.id, at(9)), 'FORBIDDEN', 'operator_only')
      const queue = await listTagMergeProposals(tx, f.O, {})
      expect(queue.find((p) => p.id === proposal.id)).toMatchObject({ proposer: { userId: C.id, displayName: '큐레이터 후보' } })
      expect(await approveTagMergeProposal(tx, f.O, proposal.id, at(9))).toMatchObject({ status: 'approved', decidedAt: at(9).toISOString() })
      expect((await tx.select().from(conceptTags).where(eq(conceptTags.id, recursionFn.id)))[0]!.mergedInto).toBe(recursion.id)
      const mergeAudit = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'concept_tag.merge'), eq(auditEvents.targetId, recursionFn.id)))
      expect(mergeAudit[0]!.metadata).toMatchObject({ into: recursion.id, proposalId: proposal.id })
      await expectServiceError(approveTagMergeProposal(tx, f.O, proposal.id, at(10)), 'CONFLICT', 'already_decided')
      expect(await rejectTagMergeProposal(tx, f.O, second.id, at(10))).toMatchObject({ status: 'rejected' })
      expect((await tx.select().from(conceptTags).where(eq(conceptTags.id, recursion.id)))[0]!.mergedInto).toBeNull()
      expect((await getCuratorWorkspace(tx, me, f.course.id)).proposals.map((p) => p.status)).toEqual(['rejected', 'approved'])

      // 팀원 찾기 끄기(C-07 자리): 자기 과목만.
      expect(await setCourseTeamFindingAsCurator(tx, me, f.course.id, { disabled: true })).toEqual({ courseId: f.course.id, teamFindingDisabled: true })
      await expectServiceError(setCourseTeamFindingAsCurator(tx, me, f.other.id, { disabled: true }), 'FORBIDDEN', 'curator_only')
      expect((await tx.select({ v: courses.teamFindingDisabled }).from(courses).where(eq(courses.id, f.other.id)))[0]!.v).toBe(false)
      expect((await getCuratorWorkspace(tx, me, f.course.id)).teamFindingDisabled).toBe(true)

      // 해제하면 다음 요청부터 모든 큐레이터 경로가 403.
      await revokeCourseCurator(tx, f.O, f.course.id, C.id, at(11))
      await expectServiceError(getCuratorWorkspace(tx, me, f.course.id), 'FORBIDDEN', 'curator_only')
      await expectServiceError(putAssignmentTypeSummary(tx, me, f.course.id, { body: 'x', expectedVersion: 0 }, at(12)), 'FORBIDDEN', 'curator_only')
      await expectServiceError(setCourseTeamFindingAsCurator(tx, me, f.course.id, { disabled: false }), 'FORBIDDEN', 'curator_only')
      await expectServiceError(listCuratorReports(tx, me, f.course.id, at(12)), 'FORBIDDEN', 'curator_only')
      expect(await listMyCuratedCourses(tx, me)).toEqual([])
    })
  })

  it('first-pass report review: own course hub items only, no reporter identity or details, recommendation only; operators see it and still decide', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const C = await finishedVerified(tx, f.schoolId, f.term.id)
      const C2 = await finishedVerified(tx, f.schoolId, f.term.id)
      await createProject(tx, { userId: C2.id }, { title: '다른 과목 과제', courseTermId: f.otherTerm.id }, T0)
      await grantCourseCurator(tx, f.O, f.course.id, { userId: C.id }, at(1))
      await grantCourseCurator(tx, f.O, f.other.id, { userId: C2.id }, at(1))
      const author = await createUser(tx, { displayName: '노트 작성자' })
      await verifiedAffiliation(tx, author.id, f.schoolId)
      const note = await createSeniorNote(tx, { userId: author.id }, f.course.id, NOTE_INPUT, at(2))
      await publishSeniorNote(tx, { userId: author.id }, note.id, { expectedVersion: 1 }, at(3))
      const otherNote = await createSeniorNote(tx, { userId: author.id }, f.other.id, NOTE_INPUT, at(2))
      await publishSeniorNote(tx, { userId: author.id }, otherNote.id, { expectedVersion: 1 }, at(3))
      const owner = await createUser(tx, { displayName: '사례 주인' })
      const publication = await publishCase(tx, owner.id, f.term.id)

      const R1 = await createUser(tx, { displayName: '신고자 하나' })
      const R2 = await createUser(tx, { displayName: '신고자 둘' })
      const r1 = await createReport(tx, { userId: R1.id }, { targetType: 'senior_note', targetRef: { noteId: note.id }, reason: 'answer_sharing', details: DETAILS }, at(10))
      await createReport(tx, { userId: R2.id }, { targetType: 'senior_note', targetRef: { noteId: note.id }, reason: 'answer_sharing' }, at(11))
      const rOther = await createReport(tx, { userId: R1.id }, { targetType: 'senior_note', targetRef: { noteId: otherNote.id }, reason: 'spam' }, at(11))
      const rCase = await createReport(tx, { userId: R2.id }, { targetType: 'publication', targetRef: { slug: publication.slug }, reason: 'spam', details: DETAILS }, at(12))
      // 범위 밖(프로필)은 큐레이터에게 보이지 않습니다.
      await createUser(tx, { handle: `p-${f.t}` })
      await createReport(tx, { userId: R1.id }, { targetType: 'profile', targetRef: { handle: `p-${f.t}` }, reason: 'spam' }, at(12))

      const groups = await listCuratorReports(tx, { userId: C.id }, f.course.id, at(13))
      expect(groups.map((g) => g.targetType).sort()).toEqual(['publication', 'senior_note'])
      const noteGroup = groups.find((g) => g.targetType === 'senior_note')!
      expect(noteGroup).toMatchObject({
        reportId: r1.id,
        reasons: { answer_sharing: 2 },
        content: { kind: 'senior_note', note: { id: note.id, answers: NOTE_INPUT.answers } },
        publicPath: `/c/${f.course.id}#note-${note.id}`,
        myRecommendation: null,
      })
      expect(groups.find((g) => g.targetType === 'publication')).toMatchObject({ reportId: rCase.id, content: { kind: 'publication', title: '공개 사례' }, publicPath: `/p/${publication.slug}` })
      // 신고자 id·이름·설명·작성자 id가 어디에도 없습니다.
      const text = JSON.stringify(groups)
      for (const hidden of [R1.id, R2.id, '신고자 하나', '신고자 둘', DETAILS, author.id, owner.id, 'createdAt', 'details']) expect(text).not.toContain(hidden)

      // 다른 과목 큐레이터: 자기 과목 신고만, 남의 과목 신고에는 의견 404, 남의 과목 목록 403.
      expect((await listCuratorReports(tx, { userId: C2.id }, f.other.id, at(13))).map((g) => g.reportId)).toEqual([rOther.id])
      await expectServiceError(listCuratorReports(tx, { userId: C2.id }, f.course.id, at(13)), 'FORBIDDEN', 'curator_only')
      await expectServiceError(recommendOnReport(tx, { userId: C2.id }, f.other.id, r1.id, { recommendation: 'hide' }, at(13)), 'NOT_FOUND')
      await expectServiceError(recommendOnReport(tx, { userId: C2.id }, f.course.id, r1.id, { recommendation: 'hide' }, at(13)), 'FORBIDDEN', 'curator_only')

      // 의견: 묶음의 가장 오래된 신고에 붙고, 다시 내면 고침. 신고 상태는 그대로.
      expect(await recommendOnReport(tx, { userId: C.id }, f.course.id, r1.id, { recommendation: 'dismiss', note: '답안이 아니라 접근법' }, at(14))).toEqual({
        reportId: r1.id,
        recommendation: 'dismiss',
        note: '답안이 아니라 접근법',
      })
      expect((await recommendOnReport(tx, { userId: C.id }, f.course.id, r1.id, { recommendation: 'hide', note: null }, at(15))).recommendation).toBe('hide')
      expect((await expectServiceError(recommendOnReport(tx, { userId: C.id }, f.course.id, r1.id, { recommendation: 'restrict' }, at(15)), 'VALIDATION')).fields).toEqual({ recommendation: 'invalid' })
      expect((await listCuratorReports(tx, { userId: C.id }, f.course.id, at(16))).find((g) => g.reportId === r1.id)!.myRecommendation).toEqual({ recommendation: 'hide', note: null, updatedAt: at(15).toISOString() })
      expect((await tx.select({ status: reports.status }).from(reports).where(eq(reports.targetKey, (await tx.select().from(reports).where(eq(reports.id, r1.id)))[0]!.targetKey))).map((r) => r.status)).toEqual(['open', 'open'])

      // 큐레이터는 처리·기각·상세(작성자·신고자 설명)를 못 봄.
      await expectServiceError(getReportDetail(tx, { userId: C.id }, r1.id, at(16)), 'FORBIDDEN', 'operator_only')
      await expectServiceError(resolveReport(tx, { userId: C.id }, r1.id, { action: 'hide_note', note: 'x' }, at(16)), 'FORBIDDEN', 'operator_only')
      await expectServiceError(dismissReport(tx, { userId: C.id }, r1.id, { note: 'x' }, at(16)), 'FORBIDDEN', 'operator_only')
      await expectServiceError(listReportGroups(tx, { userId: C.id }, {}, at(16)), 'FORBIDDEN', 'operator_only')

      // 운영자: 대기열 표시 + 상세의 의견(큐레이터 이름 포함) → 운영자가 처리하면 큐레이터 목록에서 사라짐.
      const opGroups = await listReportGroups(tx, f.O, {}, at(16))
      expect(opGroups.find((g) => g.reportId === r1.id)!.curatorRecommended).toBe(true)
      expect(opGroups.find((g) => g.reportId === rCase.id)!.curatorRecommended).toBe(false)
      const detail = await getReportDetail(tx, f.O, r1.id, at(16))
      expect(detail.curatorRecommendations).toEqual([
        { reportId: r1.id, recommendation: 'hide', note: null, curator: { userId: C.id, displayName: '큐레이터 후보' }, createdAt: at(14).toISOString(), updatedAt: at(15).toISOString() },
      ])
      const audit = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'curator.report_recommend'))
      expect(audit.filter((a) => a.targetId === r1.id).map((a) => a.metadata)).toEqual([
        { courseId: f.course.id, recommendation: 'dismiss' },
        { courseId: f.course.id, recommendation: 'hide' },
      ])
      await dismissReport(tx, f.O, r1.id, { note: '접근법 설명이라 기각' }, at(17))
      expect((await listCuratorReports(tx, { userId: C.id }, f.course.id, at(18))).map((g) => g.reportId)).toEqual([rCase.id])
      await expectServiceError(recommendOnReport(tx, { userId: C.id }, f.course.id, r1.id, { recommendation: 'hide' }, at(18)), 'NOT_FOUND')
      // 처리 뒤에도 운영 기록으로 의견이 남습니다.
      expect((await getReportDetail(tx, f.O, r1.id, at(18))).curatorRecommendations).toHaveLength(1)
    })
  })

  it('portfolio shows curated courses only when the curator opts in (default off), and not after removal', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const handle = `cur-${f.t}`
      const C = await finishedVerified(tx, f.schoolId, f.term.id, handle)
      const me = { userId: C.id }
      expect((await getPublicPortfolioProfile(tx, handle, at(1))).juniorContribution.curatedCourses).toEqual([])
      await grantCourseCurator(tx, f.O, f.course.id, { userId: C.id }, at(1))
      expect(await listMyCuratedCourses(tx, me)).toEqual([{ course: expect.objectContaining({ id: f.course.id }), grantedAt: at(1).toISOString(), showInPortfolio: false }])
      expect((await getPublicPortfolioProfile(tx, handle, at(2))).juniorContribution.curatedCourses).toEqual([])
      expect((await setCuratorPortfolioDisplay(tx, me, f.course.id, { showInPortfolio: true })).showInPortfolio).toBe(true)
      const profile = await getPublicPortfolioProfile(tx, handle, at(3))
      expect(profile.juniorContribution.curatedCourses).toEqual([{ courseTitle: f.course.title, schoolName: expect.stringContaining('큐레이터대') }])
      // 다른 사람·큐레이터가 아닌 과목은 404, 형식 오류 422.
      await expectServiceError(setCuratorPortfolioDisplay(tx, me, f.other.id, { showInPortfolio: true }), 'NOT_FOUND')
      await expectServiceError(setCuratorPortfolioDisplay(tx, { userId: f.O.userId }, f.course.id, { showInPortfolio: true }), 'NOT_FOUND')
      expect((await expectServiceError(setCuratorPortfolioDisplay(tx, me, f.course.id, { showInPortfolio: 'yes' }), 'VALIDATION')).fields).toEqual({ showInPortfolio: 'invalid' })
      await setCuratorPortfolioDisplay(tx, me, f.course.id, { showInPortfolio: false })
      expect((await getPublicPortfolioProfile(tx, handle, at(4))).juniorContribution.curatedCourses).toEqual([])
      await setCuratorPortfolioDisplay(tx, me, f.course.id, { showInPortfolio: true })
      await revokeCourseCurator(tx, f.O, f.course.id, C.id, at(5))
      expect((await getPublicPortfolioProfile(tx, handle, at(6))).juniorContribution.curatedCourses).toEqual([])
    })
  })

  it('course merge moves assignments, summaries and proposals to the canonical course; a curator on both keeps one seat', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const dup = await createCourse(tx, f.O, f.schoolId, { title: `운영체제 중복${f.t}`, code: `OSX-${f.t}`, confirmNew: true }, T0)
      const { term: dupTerm } = await createCourseTerm(tx, f.O, dup.id, { year: 2025, semester: 'fall' }, T0)
      const A = await finishedVerified(tx, f.schoolId, dupTerm.id)
      const B = await finishedVerified(tx, f.schoolId, dupTerm.id)
      await createProject(tx, { userId: B.id }, { title: '정본 과목 과제', courseTermId: f.term.id }, T0)
      await grantCourseCurator(tx, f.O, dup.id, { userId: A.id }, at(1))
      await grantCourseCurator(tx, f.O, dup.id, { userId: B.id }, at(1))
      await grantCourseCurator(tx, f.O, f.course.id, { userId: B.id }, at(1))
      await putAssignmentTypeSummary(tx, { userId: A.id }, dup.id, { body: '중복 과목에서 쓴 요약', expectedVersion: 0 }, at(2))

      await mergeCourse(tx, f.O, dup.id, { into: f.course.id }, at(3))
      expect((await listCourseCurators(tx, f.O, f.course.id)).map((c) => c.userId).sort()).toEqual([A.id, B.id].sort())
      expect(await curatedCourseIds(tx, A.id)).toEqual([f.course.id])
      // 병합된 id로 와도 정본으로 판정합니다.
      expect((await getCuratorWorkspace(tx, { userId: A.id }, dup.id)).course.id).toBe(f.course.id)
      expect((await getPublicCourseHub(tx, f.course.id, at(4))).assignmentTypeSummary?.body).toBe('중복 과목에서 쓴 요약')
      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'course.merge'), eq(auditEvents.targetId, dup.id)))
      expect(audit[0]!.metadata).toMatchObject({ curatorsMoved: 2, curatorsClosed: 1 })
    })
  })
})

// ── 소스 검사: 큐레이터 경로가 신고자·작성자 확인·운영 조치에 닿지 않는지 ─────────────────
const SERVER = join(import.meta.dirname, '..', 'server')
const listTs = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listTs(path) : path.endsWith('.ts') ? [path] : []
  })

describe('E-03 boundary lint: curator paths never see reporters or take operator actions (source)', () => {
  it('the curator report review never reads reporter ids, report details or assignment; curator routes do not import operator moderation or author lookups', () => {
    const review = readFileSync(join(SERVER, 'modules/curators/report-review.ts'), 'utf8').replace(/\/\*\*[\s\S]*?\*\//g, '')
    for (const banned of ['reporterId', 'reporter_id', '.details', 'assignedTo', 'applyModeration', 'author-lookups', 'personas']) expect(review, banned).not.toContain(banned)
    const routes = listTs(join(SERVER, 'api/v1/curator'))
    expect(routes.length).toBe(5)
    for (const f of routes) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/moderation\/(operator|actions)|author-lookups|persona-owner|course-registrations/)
    }
  })
})
