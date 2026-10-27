/**
 * C-07 모집·지원·마감 통합 테스트(DELIVERY_PLAN §4.1 C-07·§5.1 N, PROOFU_EVOLUTION_PLAN §8.8·§8.9.5, ADR 0024).
 *
 * - 지원자 목록은 모집자만(모더레이터·운영자·다른 지원자 403/404), DTO에 순위·활동량 필드 없음, 지원 시각 순서.
 * - 첨부(공개 프로필·공개 사례)는 지원할 때 확인하고 읽을 때 다시 확인(철회된 사례는 사라짐).
 * - 모집 인원까지 선정, 팀원 찾기 마감 → 비공개 과제 공간 + 초대(자동 멤버십 없음, 학기 엠바고), 스터디 마감 → 초대 전용 스터디 방 + 초대.
 * - 거절은 사유 없이, 취소 알림, 과목 팀원 찾기 끄기, 이용 제한, 모집·지원 신고와 가리기, 센티넬(커뮤니티 밖 테이블·공개 조회에 0건).
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교·사용자만 봅니다.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { RECRUITER_APPLICATION_KEYS, RECRUITMENT_NOT_SELECTED_TEXT } from '@peerchive/domain'
import {
  analyticsEvents,
  communityNotices,
  communitySpaces,
  eq,
  invitations,
  operators,
  projectMembers,
  projects,
  recruitmentApplications,
  spaceMemberships,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { removeAffiliation } from '../server/modules/affiliation/affiliations'
import { setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { acceptSpaceInvitation } from '../server/modules/community/invitations'
import { joinSpace } from '../server/modules/community/memberships'
import { issueSanction, lookupAuthor } from '../server/modules/community/moderation'
import { listMyCommunityNotices } from '../server/modules/community/notices'
import { assignModerator, createOfficialPage } from '../server/modules/community/official'
import { createPost } from '../server/modules/community/posts'
import {
  acceptApplication,
  applyToRecruitment,
  attachmentOptions,
  cancelRecruitment,
  closeRecruitment,
  courseTeamFindingEntry,
  createRecruitment,
  declineApplication,
  getRecruitment,
  issueRecruitmentInvitation,
  listApplications,
  listMyRecruitments,
  listRecruitments,
  setCourseTeamFinding,
  withdrawApplication,
} from '../server/modules/community/recruitments'
import { createBoard, createRoom, getSpaceDetail } from '../server/modules/community/spaces'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { searchPublic } from '../server/modules/course-hub/search'
import { getPublicProfile } from '../server/modules/identity/profiles'
import { createLog } from '../server/modules/logs/logs'
import { createReport } from '../server/modules/moderation/reports'
import { getReportDetail, resolveReport } from '../server/modules/moderation/operator'
import { acceptInvitation } from '../server/modules/projects/invitations'
import { createProject, getProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { COMMUNITY_TABLE_SQL } from './community-tables'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-04T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const DB_TIMEOUT = 60_000

interface World {
  op: { userId: string }
  schoolId: string
  courseId: string
  termId: string
  officialSlug: string
  recruiter: { userId: string }
  a: { userId: string; affiliationId: string }
  b: { userId: string; affiliationId: string }
  c: { userId: string; affiliationId: string }
  other: { userId: string; affiliationId: string }
}

async function student(tx: DbExecutor, schoolId: string, name = '학생'): Promise<{ userId: string; affiliationId: string }> {
  const u = await createUser(tx, { handle: `r${rand()}`, displayName: name })
  const aff = await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id, affiliationId: aff.id }
}

async function world(tx: DbExecutor): Promise<World> {
  const op = { userId: (await createUser(tx)).id }
  await tx.insert(operators).values({ userId: op.userId })
  const school = await createSchool(tx, op, { name: `모집대${rand()}학교`, confirmNew: true }, T0)
  const otherSchool = await createSchool(tx, op, { name: `남의대${rand()}학교`, confirmNew: true }, T0)
  const recruiter = await student(tx, school.id, '모집자')
  const course = await createCourse(tx, recruiter, school.id, { title: `운영체제${rand()}`, code: `OS-${rand().slice(0, 4)}`, confirmNew: true }, T0)
  const { term } = await createCourseTerm(tx, recruiter, course.id, { year: 2026, semester: 'fall' }, T0)
  const official = await createOfficialPage(tx, op, { schoolId: school.id, name: `모집대 공식 ${rand()}` }, T0)
  return {
    op,
    schoolId: school.id,
    courseId: course.id,
    termId: term.id,
    officialSlug: official.slug,
    recruiter,
    a: await student(tx, school.id, '지원자A'),
    b: await student(tx, school.id, '지원자B'),
    c: await student(tx, school.id, '지원자C'),
    other: await student(tx, otherSchool.id, '다른학교'),
  }
}

const study = (w: World, over: Record<string, unknown> = {}) => ({ kind: 'study', courseId: w.courseId, title: '운영체제 스터디', description: '주 1회', capacity: 2, ...over })
const team = (w: World, over: Record<string, unknown> = {}) => ({ kind: 'team', courseId: w.courseId, termId: w.termId, title: '팀원 구합니다', capacity: 2, ...over })

describe.skipIf(!databaseUrl)('C-07 recruitments (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => setAnalyticsEnvForTesting(null))

  it('only the recruiter sees applicants (moderator, operator, other applicants: 403; outsiders: 404), in application-time order with no ranking fields', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const moderator = await student(tx, w.schoolId, '모더레이터')
      const [space] = await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.slug, w.officialSlug))
      await assignModerator(tx, w.op, space!.id, { userId: moderator.userId }, at(0))
      const rec = await createRecruitment(tx, w.recruiter, study(w, { courseId: undefined, spaceSlug: w.officialSlug }), at(1))
      expect(rec).toMatchObject({ kind: 'study', mine: true, space: { slug: w.officialSlug, official: true }, recruiter: { applicationCount: 0 } })
      await applyToRecruitment(tx, w.b, rec.id, { message: '두 번째로 보이면 안 됨' }, at(3))
      await applyToRecruitment(tx, w.a, rec.id, { message: '먼저 지원' }, at(2))
      await applyToRecruitment(tx, w.c, rec.id, {}, at(4))

      const list = await listApplications(tx, w.recruiter, rec.id, at(5))
      expect(list.map((a) => a.applicant.displayName)).toEqual(['지원자A', '지원자B', '지원자C'])
      for (const item of list) expect(Object.keys(item).sort()).toEqual([...RECRUITER_APPLICATION_KEYS].sort())
      expect(JSON.stringify(list)).not.toMatch(/fork|endorse|activity|score|rank|reason|userId|applicantId|email/i)

      // 모더레이터·운영자·다른 지원자: 모집은 읽지만 지원자는 못 봄(403), 다른 학교: 404
      for (const actor of [moderator, w.op, w.a, w.b]) await expectServiceError(listApplications(tx, actor, rec.id, at(5)), 'FORBIDDEN', 'recruiter_only')
      await expectServiceError(listApplications(tx, w.other, rec.id, at(5)), 'NOT_FOUND')
      await expectServiceError(getRecruitment(tx, w.other, rec.id, at(5)), 'NOT_FOUND')
      for (const actor of [moderator, w.op, w.a]) {
        await expectServiceError(acceptApplication(tx, actor, rec.id, list[1]!.id, at(5)), 'FORBIDDEN', 'recruiter_only')
        await expectServiceError(closeRecruitment(tx, actor, rec.id, at(5)), 'FORBIDDEN', 'recruiter_only')
      }

      // 지원자에게는 자기 상태만, 지원자 수는 공개하지 않음(모집자에게만)
      const asA = await getRecruitment(tx, w.a, rec.id, at(5))
      expect(asA.recruiter).toBeNull()
      expect(asA.myApplication).toMatchObject({ status: 'pending', statusText: '검토 중', message: '먼저 지원' })
      expect(JSON.stringify(asA)).not.toContain('두 번째')
      expect(JSON.stringify(asA)).not.toContain('지원자B')
      const board = await listRecruitments(tx, w.a, { space: w.officialSlug }, at(5))
      expect(JSON.stringify(board)).not.toMatch(/applicationCount|pendingCount|acceptedCount|지원자B/)
      expect((await getRecruitment(tx, w.recruiter, rec.id, at(5))).recruiter).toMatchObject({ applicationCount: 3, pendingCount: 3, acceptedCount: 0 })

      // 지원·선정·거절은 감사 기록을 남기지 않음(감사 조회로 지원자를 찾을 수 없게)
      await acceptApplication(tx, w.recruiter, rec.id, list[0]!.id, at(6))
      const audits = (await tx.execute(sql`select action, metadata::text as m from audit_events where target_id = ${rec.id} or metadata::text like ${`%${list[0]!.id}%`}`)) as unknown as Array<{ action: string; m: string }>
      expect(audits.map((a) => a.action)).toEqual(['community.recruitment_create'])
      for (const p of [w.a, w.b, w.c]) expect(JSON.stringify(audits)).not.toContain(p.userId)
    })
  }, DB_TIMEOUT)

  it('attachments: only own public profile and own live cases at apply time; withdrawn cases disappear when read', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      // A가 팀원인 과제의 공개 사례(지난 학기 → 엠바고 없음)
      const { term: past } = await createCourseTerm(tx, w.a, w.courseId, { year: 2025, semester: 'spring' }, T0)
      const project = await createProject(tx, w.a, { title: '공개 과제', courseTermId: past.id }, T0)
      const log = (await createLog(tx, w.a, project.id, { tag: 'progress', body: '파서 완성', links: [] }, at(1))).log
      const slug = `rec-${rand().slice(0, 8)}`
      const cand = await createCandidate(
        tx,
        w.a,
        project.id,
        { level: 'summary', title: '컴파일러 과제', summary: '요약', slug, logIds: [log.id], milestoneIds: [], exposure: { [w.a.userId]: 'name' }, consentSelf: true },
        at(2),
        ORIGINS,
      )
      const published = await publishCandidate(tx, w.a, cand.id, { manifestHash: cand.manifestHash }, at(3))
      const opts = await attachmentOptions(tx, w.a, at(4))
      expect(opts.profile).not.toBeNull()
      expect(opts.cases).toEqual([{ slug, title: '컴파일러 과제' }])
      expect((await attachmentOptions(tx, w.b, at(4))).cases).toEqual([])

      const rec = await createRecruitment(tx, w.recruiter, study(w), at(5))
      // 남의 사례·없는 사례는 422
      const err = await expectServiceError(applyToRecruitment(tx, w.b, rec.id, { caseSlugs: [slug, 'nope-nope'] }, at(6)), 'VALIDATION')
      expect(err.fields).toEqual({ 'caseSlugs.0': 'not_yours', 'caseSlugs.1': 'not_yours' })
      await applyToRecruitment(tx, w.a, rec.id, { message: '사례 첨부', attachProfile: true, caseSlugs: [slug] }, at(6))
      const [item] = await listApplications(tx, w.recruiter, rec.id, at(7))
      expect(item!.attachments).toEqual({ profile: opts.profile, cases: [{ slug, title: '컴파일러 과제' }] })

      // 공개를 철회하면 다음 읽기부터 첨부에서 빠짐
      await withdrawPublication(tx, w.a, published.publication.id, { reason: '철회' }, at(8))
      const [after] = await listApplications(tx, w.recruiter, rec.id, at(9))
      expect(after!.attachments.cases).toEqual([])
      expect(after!.attachments.profile).toEqual(opts.profile)
      expect((await getRecruitment(tx, w.a, rec.id, at(9))).myApplication!.attachments.cases).toEqual([])
    })
  }, DB_TIMEOUT)

  it('accepts up to capacity; decline carries no reason; withdraw; double apply; own recruitment', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const rec = await createRecruitment(tx, w.recruiter, study(w, { capacity: 2 }), at(1))
      await expectServiceError(applyToRecruitment(tx, w.recruiter, rec.id, {}, at(2)), 'FORBIDDEN', 'own_recruitment')
      for (const [i, p] of [w.a, w.b, w.c].entries()) await applyToRecruitment(tx, p, rec.id, { message: `지원 ${i}` }, at(2 + i))
      await expectServiceError(applyToRecruitment(tx, w.a, rec.id, {}, at(6)), 'CONFLICT', 'already_applied')
      const [a, b, c] = await listApplications(tx, w.recruiter, rec.id, at(6))
      await acceptApplication(tx, w.recruiter, rec.id, a!.id, at(7))
      await acceptApplication(tx, w.recruiter, rec.id, b!.id, at(7))
      await expectServiceError(acceptApplication(tx, w.recruiter, rec.id, c!.id, at(8)), 'CONFLICT', 'capacity_full')
      await expectServiceError(acceptApplication(tx, w.recruiter, rec.id, a!.id, at(8)), 'CONFLICT', 'not_pending')
      // 거절: 사유 없이. 선정한 사람도 마감 전에는 선정 취소(선정 안 함)할 수 있고 그러면 자리가 납니다.
      const declined = await declineApplication(tx, w.recruiter, rec.id, b!.id, at(9))
      expect(declined.status).toBe('declined')
      expect(Object.keys(declined).sort()).toEqual([...RECRUITER_APPLICATION_KEYS].sort())
      await acceptApplication(tx, w.recruiter, rec.id, c!.id, at(10))
      const asB = await getRecruitment(tx, w.b, rec.id, at(10))
      expect(asB.myApplication).toMatchObject({ status: 'declined', statusText: RECRUITMENT_NOT_SELECTED_TEXT })
      const notices = await listMyCommunityNotices(tx, w.b)
      expect(notices.items).toMatchObject([{ kind: 'recruitment_not_selected', recruitmentId: rec.id, text: RECRUITMENT_NOT_SELECTED_TEXT, recruitmentKind: 'study' }])
      // 사유를 담을 열이 없음
      const cols = (await tx.execute(sql`select column_name from information_schema.columns where table_name in ('recruitment_applications', 'recruitments')`)) as unknown as Array<{ column_name: string }>
      expect(cols.map((c) => c.column_name).filter((n) => /reason|score|rank|note/.test(n))).toEqual([])
      // 지원 취소: 선정된 사람도 마감 전에는 취소
      expect((await withdrawApplication(tx, w.c, rec.id, at(11))).status).toBe('withdrawn')
      await expectServiceError(withdrawApplication(tx, w.c, rec.id, at(11)), 'CONFLICT', 'not_withdrawable')
      expect((await listApplications(tx, w.recruiter, rec.id, at(12))).map((x) => x.status)).toEqual(['accepted', 'declined'])
      // 내 지원 목록
      const mine = await listMyRecruitments(tx, w.b, at(12))
      expect(mine.applications).toMatchObject([{ status: 'declined', recruitment: { id: rec.id, title: '운영체제 스터디' } }])
    })
  }, DB_TIMEOUT)

  it('closing a team recruitment creates a private project (owner = recruiter, term embargo) and invitations; accepted applicants are not members until they accept', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'recruitment-analytics-pepper-for-tests-0123456789' })
      const w = await world(tx)
      const rec = await createRecruitment(tx, w.recruiter, team(w), at(1))
      await expectServiceError(closeRecruitment(tx, w.recruiter, rec.id, at(2)), 'CONFLICT', 'no_accepted')
      await applyToRecruitment(tx, w.a, rec.id, {}, at(2))
      await applyToRecruitment(tx, w.b, rec.id, {}, at(3))
      const [a] = await listApplications(tx, w.recruiter, rec.id, at(4))
      await acceptApplication(tx, w.recruiter, rec.id, a!.id, at(4))
      // 마감 전에는 초대를 받을 수 없음
      await expectServiceError(issueRecruitmentInvitation(tx, w.a, rec.id, at(4)), 'CONFLICT', 'not_closed')
      const closed = await closeRecruitment(tx, w.recruiter, rec.id, at(5))
      expect(closed).toMatchObject({ status: 'closed', recruiter: { acceptedCount: 1, result: { spaceSlug: null } } })
      const projectId = closed.recruiter!.result.projectId!
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId))
      expect(project).toMatchObject({ ownerId: w.recruiter.userId, kind: 'team', courseTermId: w.termId })
      // 모집 글 내용이 과제 공간으로 옮겨지지 않음(제목은 과목 이름)
      expect(project!.title).toMatch(/팀 과제$/)
      expect(project!.title).not.toContain('팀원 구합니다')
      // 학기(2026 가을) 엠바고가 걸림
      const detail = await getProject(tx, w.recruiter, projectId, at(6))
      expect(detail.visibility).toBe('private')
      expect(detail.embargo.active).toBe(true)
      // 선정된 사람은 아직 멤버가 아님
      expect((await tx.select().from(projectMembers).where(eq(projectMembers.projectId, projectId))).map((m) => m.userId)).toEqual([w.recruiter.userId])
      await expectServiceError(getProject(tx, w.a, projectId, at(6)), 'NOT_FOUND')
      // 알림: 선정 → 초대 받기, 검토 중이던 B → 선정되지 않음(같은 문장)
      expect((await listMyCommunityNotices(tx, w.a)).items).toMatchObject([{ kind: 'recruitment_invited', recruitmentId: rec.id }])
      expect((await listMyCommunityNotices(tx, w.b)).items).toMatchObject([{ kind: 'recruitment_not_selected', text: RECRUITMENT_NOT_SELECTED_TEXT }])
      expect((await getRecruitment(tx, w.a, rec.id, at(6))).myApplication).toMatchObject({ status: 'accepted', invitationAvailable: true })
      await expectServiceError(issueRecruitmentInvitation(tx, w.b, rec.id, at(6)), 'CONFLICT', 'not_selected')

      // 초대 받기(다시 받으면 이전 링크 취소) → 본인이 수락해야 멤버
      const first = await issueRecruitmentInvitation(tx, w.a, rec.id, at(7))
      const second = await issueRecruitmentInvitation(tx, w.a, rec.id, at(8))
      expect(first.kind).toBe('project')
      const inv = await tx.select().from(invitations).where(eq(invitations.projectId, projectId))
      expect(inv.map((i) => [i.role, i.createdBy, i.revokedAt !== null]).sort()).toEqual(
        [
          ['editor', w.recruiter.userId, false],
          ['editor', w.recruiter.userId, true],
        ].sort(),
      )
      await expectServiceError(acceptInvitation(tx, w.a, { token: first.token }, at(9)), 'GONE')
      expect(await acceptInvitation(tx, w.a, { token: second.token }, at(9))).toMatchObject({ projectId, role: 'editor' })
      expect((await getProject(tx, w.a, projectId, at(10))).myRole).toBe('editor')
      await expectServiceError(issueRecruitmentInvitation(tx, w.a, rec.id, at(11)), 'CONFLICT', 'already_member')
      // 마감 뒤에는 지원·선정·취소 불가
      await expectServiceError(applyToRecruitment(tx, w.c, rec.id, {}, at(11)), 'CONFLICT', 'recruitment_not_open')
      await expectServiceError(cancelRecruitment(tx, w.recruiter, rec.id, at(11)), 'CONFLICT', 'recruitment_not_open')
      // 분석: 종류·결과만
      const events = await tx.select().from(analyticsEvents).where(sql`${analyticsEvents.name} in ('recruitment_created', 'application_submitted', 'recruitment_closed')`)
      const recent = events.filter((e) => e.occurredAt >= T0)
      expect(recent.map((e) => [e.name, e.props]).sort()).toEqual(
        [
          ['application_submitted', { kind: 'team' }],
          ['application_submitted', { kind: 'team' }],
          ['recruitment_closed', { kind: 'team', outcome: 'project' }],
          ['recruitment_created', { kind: 'team' }],
        ].sort(),
      )
    })
  }, DB_TIMEOUT)

  it('closing a study recruitment creates an invite-only unlisted study room (chosen name mode) and invitations; the invitee joins only by accepting', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const rec = await createRecruitment(tx, w.recruiter, study(w, { roomNameMode: 'anonymous' }), at(1))
      await applyToRecruitment(tx, w.a, rec.id, {}, at(2))
      await applyToRecruitment(tx, w.b, rec.id, {}, at(3))
      const [a] = await listApplications(tx, w.recruiter, rec.id, at(4))
      await acceptApplication(tx, w.recruiter, rec.id, a!.id, at(4))
      const closed = await closeRecruitment(tx, w.recruiter, rec.id, at(5))
      const slug = closed.recruiter!.result.spaceSlug!
      const [room] = await tx.select().from(communitySpaces).where(eq(communitySpaces.slug, slug))
      expect(room).toMatchObject({ kind: 'study_room', joinPolicy: 'invite', discovery: 'unlisted', currentNameMode: 'anonymous', linkedCourseId: w.courseId, name: '운영체제 스터디' })
      expect((await tx.select().from(spaceMemberships).where(eq(spaceMemberships.spaceId, room!.id))).map((m) => [m.userId, m.role])).toEqual([[w.recruiter.userId, 'owner']])
      await expectServiceError(getSpaceDetail(tx, w.a, slug, at(6)), 'NOT_FOUND')
      // 스스로 들어갈 수 없음(초대 전용)
      await expectServiceError(joinSpace(tx, w.a, slug, at(6)), 'FORBIDDEN', 'invite_only')
      const issued = await issueRecruitmentInvitation(tx, w.a, rec.id, at(7))
      expect(issued.kind).toBe('space')
      expect(await acceptSpaceInvitation(tx, w.a, { token: issued.token }, at(8))).toMatchObject({ status: 'active' })
      expect(await getSpaceDetail(tx, w.a, slug, at(9))).toMatchObject({ access: 'member', kind: 'study_room' })
      // 선정되지 않은 B는 초대를 받을 수 없고 방도 못 봄
      await expectServiceError(issueRecruitmentInvitation(tx, w.b, rec.id, at(9)), 'CONFLICT', 'not_selected')
      await expectServiceError(getSpaceDetail(tx, w.b, slug, at(9)), 'NOT_FOUND')
    })
  }, DB_TIMEOUT)

  it('cancel notifies pending and accepted applicants generically', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const rec = await createRecruitment(tx, w.recruiter, study(w), at(1))
      await applyToRecruitment(tx, w.a, rec.id, {}, at(2))
      await applyToRecruitment(tx, w.b, rec.id, {}, at(3))
      await applyToRecruitment(tx, w.c, rec.id, {}, at(4))
      const [a] = await listApplications(tx, w.recruiter, rec.id, at(5))
      await acceptApplication(tx, w.recruiter, rec.id, a!.id, at(5))
      await withdrawApplication(tx, w.c, rec.id, at(6))
      expect((await cancelRecruitment(tx, w.recruiter, rec.id, at(7))).status).toBe('cancelled')
      for (const p of [w.a, w.b]) expect((await listMyCommunityNotices(tx, p)).items).toMatchObject([{ kind: 'recruitment_cancelled', text: '모집이 취소되었습니다.' }])
      expect((await listMyCommunityNotices(tx, w.c)).items).toEqual([])
      const rows = await tx.select().from(communityNotices).where(eq(communityNotices.recruitmentId, rec.id))
      for (const r of rows) expect(r.payload).toEqual({ recruitmentKind: 'study' })
      await expectServiceError(closeRecruitment(tx, w.recruiter, rec.id, at(8)), 'CONFLICT', 'recruitment_not_open')
    })
  }, DB_TIMEOUT)

  it('a course flagged as team-assigned hides team recruiting (curator hook, operator-set) but keeps study recruiting', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const teamRec = await createRecruitment(tx, w.recruiter, team(w), at(1))
      const studyRec = await createRecruitment(tx, w.recruiter, study(w), at(1))
      expect(await courseTeamFindingEntry(tx, w.a, w.courseId, at(2))).toEqual({ available: true })
      expect(await courseTeamFindingEntry(tx, w.other, w.courseId, at(2))).toEqual({ available: false })
      await expectServiceError(setCourseTeamFinding(tx, w.a, w.courseId, { disabled: true }), 'FORBIDDEN', 'operator_only')
      expect(await setCourseTeamFinding(tx, w.op, w.courseId, { disabled: true })).toEqual({ courseId: w.courseId, teamFindingDisabled: true })
      expect(await courseTeamFindingEntry(tx, w.a, w.courseId, at(3))).toEqual({ available: false })
      const listed = await listRecruitments(tx, w.a, { course: w.courseId }, at(3))
      expect(listed.items.map((r) => r.id)).toEqual([studyRec.id])
      expect(listed).toMatchObject({ teamFindingDisabled: true, canPost: { team: false, study: true }, postBlockedReasons: { team: 'team_finding_disabled' } })
      await expectServiceError(getRecruitment(tx, w.a, teamRec.id, at(3)), 'NOT_FOUND')
      await expectServiceError(applyToRecruitment(tx, w.a, teamRec.id, {}, at(3)), 'NOT_FOUND')
      await expectServiceError(createRecruitment(tx, w.a, team(w), at(3)), 'CONFLICT', 'team_finding_disabled')
      // 모집자 본인은 계속 보고 취소할 수 있음
      expect((await listRecruitments(tx, w.recruiter, { course: w.courseId }, at(3))).items.map((r) => r.id).sort()).toEqual([teamRec.id, studyRec.id].sort())
      expect((await cancelRecruitment(tx, w.recruiter, teamRec.id, at(4))).status).toBe('cancelled')
      // 과목 맥락은 그 학교 인증 사용자만(공개 아님)
      await expectServiceError(listRecruitments(tx, w.other, { course: w.courseId }, at(4)), 'NOT_FOUND')
    })
  }, DB_TIMEOUT)

  it('posting needs the school affiliation and a recruiting board; sanctions block posting and applying; revoked affiliation hides the recruitment', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      // 방: 모집 게시판이 없으면 409, 더하면 멤버가 올림
      const room = await createRoom(tx, w.recruiter, { name: `스터디방${rand()}`, nameMode: 'display', schoolId: w.schoolId, joinPolicy: 'open' }, at(0))
      await expectServiceError(createRecruitment(tx, w.recruiter, study(w, { courseId: undefined, spaceSlug: room.slug }), at(1)), 'CONFLICT', 'no_recruiting_board')
      await createBoard(tx, w.recruiter, room.slug, { kind: 'recruiting', title: '모집' }, at(1))
      const inRoom = await createRecruitment(tx, w.recruiter, study(w, { courseId: undefined, spaceSlug: room.slug }), at(2))
      // 비멤버는 방 모집을 못 봄(404), 가입하면 봄
      await expectServiceError(getRecruitment(tx, w.a, inRoom.id, at(3)), 'NOT_FOUND')
      await expectServiceError(listRecruitments(tx, w.a, { space: room.slug }, at(3)), 'NOT_FOUND')
      await joinSpace(tx, w.a, room.slug, at(3))
      expect((await listRecruitments(tx, w.a, { space: room.slug }, at(4))).items.map((r) => r.id)).toEqual([inRoom.id])
      // 다른 학교 사람은 과목 모집을 올릴 수 없음
      await expectServiceError(createRecruitment(tx, w.other, study(w), at(4)), 'FORBIDDEN', 'affiliation_required')
      // 팀원 찾기는 과목 필수
      await expectServiceError(createRecruitment(tx, w.recruiter, { kind: 'team', spaceSlug: w.officialSlug, title: 'x', capacity: 2 }, at(4)), 'VALIDATION')
      // 스터디 제목은 방 이름이 되므로 예약어 거부
      const bad = await expectServiceError(createRecruitment(tx, w.recruiter, study(w, { title: '운영자 스터디' }), at(4)), 'VALIDATION')
      expect(bad.fields).toEqual({ title: 'reserved' })

      // 이용 제한(커뮤니티 전체 쓰기 제한): 올리기·지원 403 write_restricted
      const target = await createRecruitment(tx, w.recruiter, study(w), at(5))
      const [boardRow] = (await getSpaceDetail(tx, w.b, w.officialSlug, at(5))).boards.filter((b) => b.kind === 'free')
      const post = await createPost(tx, w.b, boardRow!.id, { title: '글', body: '본문' }, at(5))
      const lookup = await lookupAuthor(tx, w.op, { targetType: 'post', targetId: post.id, reason: '반복 스팸 확인' }, at(6))
      await issueSanction(tx, w.op, { lookupId: lookup.lookupId, level: 'write_suspended', scope: 'community', days: 7, note: '메모', publicReason: '스팸' }, at(6))
      await expectServiceError(applyToRecruitment(tx, w.b, target.id, {}, at(7)), 'FORBIDDEN', 'write_restricted')
      await expectServiceError(createRecruitment(tx, w.b, study(w), at(7)), 'FORBIDDEN', 'write_restricted')
      expect((await getRecruitment(tx, w.b, target.id, at(7))).applyBlockedReason).toBe('write_restricted')
      // 다른 사람은 그대로
      await applyToRecruitment(tx, w.c, target.id, {}, at(7))

      // 인증이 해제되면 모집도 404(지원자·모집자 모두)
      await removeAffiliation(tx, w.c, w.c.affiliationId, at(8))
      await expectServiceError(getRecruitment(tx, w.c, target.id, at(9)), 'NOT_FOUND')
      expect((await listMyRecruitments(tx, w.c, at(9))).applications).toMatchObject([{ recruitment: null }])
    })
  }, DB_TIMEOUT)

  it('rate limits: 5 recruitments and 20 applications per user per day', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await createRecruitment(tx, w.recruiter, study(w, { title: `스터디 ${i}` }), at(i))).id)
      await expectServiceError(createRecruitment(tx, w.recruiter, study(w), at(6)), 'RATE_LIMITED')
      const many: string[] = [...ids]
      const second = await student(tx, w.schoolId, '두번째모집자')
      for (let i = 0; i < 5; i++) many.push((await createRecruitment(tx, second, study(w, { title: `둘째 ${i}` }), at(i))).id)
      const third = await student(tx, w.schoolId, '세번째모집자')
      for (let i = 0; i < 5; i++) many.push((await createRecruitment(tx, third, study(w, { title: `셋째 ${i}` }), at(i))).id)
      const fourth = await student(tx, w.schoolId, '네번째모집자')
      for (let i = 0; i < 6; i++) many.push((await createRecruitment(tx, fourth, study(w, { title: `넷째 ${i}` }), at(i)).catch(() => ({ id: '' }))).id)
      const targets = many.filter(Boolean)
      expect(targets.length).toBe(20)
      for (const id of targets) await applyToRecruitment(tx, w.a, id, {}, at(10))
      const extra = await createRecruitment(tx, w.b, study(w), at(10))
      await expectServiceError(applyToRecruitment(tx, w.a, extra.id, {}, at(11)), 'RATE_LIMITED')
    })
  }, DB_TIMEOUT)

  it('reports: recruitments by readers, application messages by the recruiter only; hide actions; operator sees one item without applicant identities', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const rec = await createRecruitment(tx, w.recruiter, study(w, { description: '연락처 010-0000-0000' }), at(1))
      await applyToRecruitment(tx, w.a, rec.id, { message: '부적절한 메시지' }, at(2))
      const [app] = await listApplications(tx, w.recruiter, rec.id, at(3))
      // 지원 메시지는 모집자만 신고(지원자 본인·다른 사람·다른 학교 404)
      for (const actor of [w.a, w.b, w.other, w.op]) {
        await expectServiceError(createReport(tx, actor, { targetType: 'community_application', targetRef: { applicationId: app!.id }, reason: 'harassment' }, at(3)), 'NOT_FOUND')
      }
      const appReport = await createReport(tx, w.recruiter, { targetType: 'community_application', targetRef: { applicationId: app!.id }, reason: 'harassment' }, at(3))
      // 모집 글은 읽을 수 있는 사람만
      await expectServiceError(createReport(tx, w.other, { targetType: 'community_recruitment', targetRef: { recruitmentId: rec.id }, reason: 'personal_info' }, at(3)), 'NOT_FOUND')
      const recReport = await createReport(tx, w.b, { targetType: 'community_recruitment', targetRef: { recruitmentId: rec.id }, reason: 'personal_info' }, at(3))

      const appDetail = await getReportDetail(tx, w.op, appReport.id, at(4))
      expect(appDetail.content).toMatchObject({ kind: 'community_application', recruitmentItem: { target: 'application', message: '부적절한 메시지', hidden: false } })
      const opJson = JSON.stringify(appDetail.content)
      for (const p of [w.a, w.recruiter]) expect(opJson).not.toContain(p.userId)
      expect(opJson).not.toContain('지원자A')

      await resolveReport(tx, w.op, appReport.id, { action: 'hide_application', note: '괴롭힘', publicReason: '괴롭힘', notifyOwner: true }, at(5))
      const [hidden] = await listApplications(tx, w.recruiter, rec.id, at(6))
      expect(hidden).toMatchObject({ messageHidden: true, message: '운영 조치로 가려진 메시지입니다.' })

      await resolveReport(tx, w.op, recReport.id, { action: 'hide_recruitment', note: '개인정보', publicReason: '연락처 노출', notifyOwner: true }, at(7))
      await expectServiceError(getRecruitment(tx, w.b, rec.id, at(8)), 'NOT_FOUND')
      await expectServiceError(applyToRecruitment(tx, w.c, rec.id, {}, at(8)), 'NOT_FOUND')
      expect((await listRecruitments(tx, w.b, { course: w.courseId }, at(8))).items).toEqual([])
      expect(await getRecruitment(tx, w.recruiter, rec.id, at(8))).toMatchObject({ hidden: true, accepting: false, canReport: false })
      // 이미 지원한 A도 가려진 모집은 볼 수 없음(내 지원 목록에는 상태만)
      expect((await listMyRecruitments(tx, w.a, at(8))).applications).toMatchObject([{ recruitment: null, status: 'pending' }])
    })
  }, DB_TIMEOUT)

  it('sentinel recruitment text and application messages never leave community tables or reach public reads, even after closing into a project', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'recruitment-analytics-pepper-for-tests-0123456789' })
      const w = await world(tx)
      const sentinel = `RECSENT${rand()}`
      const teamRec = await createRecruitment(tx, w.recruiter, team(w, { title: `${sentinel} 팀`, description: `${sentinel} 소개` }), at(1))
      const studyRec = await createRecruitment(tx, w.recruiter, study(w, { title: `${sentinel.slice(0, 12)} 스터디`, description: `${sentinel} 스터디 소개` }), at(1))
      for (const rec of [teamRec, studyRec]) {
        await applyToRecruitment(tx, w.a, rec.id, { message: `${sentinel} 지원 메시지` }, at(2))
        const [app] = await listApplications(tx, w.recruiter, rec.id, at(3))
        await acceptApplication(tx, w.recruiter, rec.id, app!.id, at(3))
        await closeRecruitment(tx, w.recruiter, rec.id, at(4))
        await issueRecruitmentInvitation(tx, w.a, rec.id, at(5))
      }
      const tables = (await tx.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      )) as unknown as Array<{ table_name: string }>
      const nonCommunity = tables.map((t) => t.table_name).filter((t) => !COMMUNITY_TABLE_SQL.has(t))
      expect(nonCommunity).toEqual(expect.arrayContaining(['projects', 'invitations', 'audit_events', 'analytics_events', 'search_documents']))
      expect(COMMUNITY_TABLE_SQL.has('recruitments')).toBe(true)
      expect(COMMUNITY_TABLE_SQL.has('recruitment_applications')).toBe(true)
      const leaks: string[] = []
      for (const t of nonCommunity) {
        const [row] = (await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)} x where x::text like ${`%${sentinel.slice(0, 12)}%`}`)) as unknown as Array<{ n: number }>
        if (row!.n > 0) leaks.push(`${t}: ${row!.n}`)
      }
      // 스터디 방 이름(커뮤니티 테이블)에는 있으므로 검사가 헛돌지 않음
      expect(leaks).toEqual([])
      const [inside] = (await tx.execute(sql`select count(*)::int as n from recruitment_applications x where x::text like ${`%${sentinel}%`}`)) as unknown as Array<{ n: number }>
      expect(inside!.n).toBe(2)
      const everything = JSON.stringify([
        await searchPublic(tx, { q: sentinel }, at(20)),
        await getPublicCourseHub(tx, w.courseId, at(20)).catch(() => null),
      ])
      expect(everything).not.toContain(sentinel)
      expect(everything).not.toMatch(/teamFindingDisabled|team_finding/)
      const [p] = (await tx.execute(sql`select handle from profiles where user_id = ${w.recruiter.userId}`)) as unknown as Array<{ handle: string }>
      expect(JSON.stringify(await getPublicProfile(tx, p!.handle))).not.toContain(sentinel)
      // 이 테스트에서 만든 지원 행이 그대로 둘(지원 메시지는 커뮤니티 테이블에만)
      expect((await tx.select().from(recruitmentApplications).where(eq(recruitmentApplications.applicantId, w.a.userId))).length).toBe(2)
    })
  }, DB_TIMEOUT)
})
