/**
 * C-08 스터디 기록 통합 테스트(DELIVERY_PLAN §4.1 C-08, ADR 0026).
 *
 * - 켜기: 방장만, 내부 과제(kind study) + 연결 행, 방 이름을 옮기지 않음, 방 멤버 → 과제 멤버(방장 owner, 나머지 editor).
 * - 멤버십 파생: 초대 수락·나가기·내보내기·다시 초대·역할 변경·방장 넘기기·방장 나가기(승계)·보관·마지막 멤버 나가기. 과제 쪽 관리 경로는 409 study_managed.
 * - 열람: 비멤버·다른 학교·미인증·나간·내보내진 사람·학교 인증 해제한 멤버는 과제와 그 로그·마일스톤·할 일·파일·공개 상태에 404.
 * - 공개: 후보 → 방 멤버 모두의 동의 → 게시, 스냅샷 kind study·studyNameMode, 과목 허브 목록(kind study), 공개 페이지.
 * - 익명 방: 기록 안 이름 가림, 이름 노출 후보 422, 스냅샷은 모두 익명, 케이스 스터디 422 anonymous_study, 모집 첨부·공개 프로필에 없음.
 * - 표시명 방: 케이스 스터디 가능. 게시 뒤 방 방식이 익명으로 바뀌어도(worker 적용과 같은 두 열 변경) release는 그대로, 새 후보는 새 방식.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교·사용자만 봅니다.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { aiRetroOptIns, analyticsEvents, auditEvents, communitySpaces, eq, hashSubject, projectMembers, projects, studyRecords, type DbExecutor } from '@peerchive/db'
import { removeAffiliation } from '../server/modules/affiliation/affiliations'
import { analyticsPepper, setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { listArtifacts } from '../server/modules/artifacts/artifacts'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { acceptSpaceInvitation, createSpaceInvitation } from '../server/modules/community/invitations'
import { changeMemberRole as changeSpaceRole, leaveSpace, removeMember as removeSpaceMember } from '../server/modules/community/memberships'
import { attachmentOptions } from '../server/modules/community/recruitments'
import { archiveSpace, createRoom, createStudyRoomInternal } from '../server/modules/community/spaces'
import { enableStudyRecord, getStudyRecord } from '../server/modules/community/study-records'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { createLog, listLogs } from '../server/modules/logs/logs'
import { createMilestone, listMilestones } from '../server/modules/milestones/milestones'
import { createCaseStudy } from '../server/modules/portfolio/case-studies'
import { createInvitation } from '../server/modules/projects/invitations'
import { changeMemberRole, leaveProject, listMembers, removeMember, transferOwnership } from '../server/modules/projects/members'
import { getProject, listMyProjects, updateProject } from '../server/modules/projects/projects'
import { createCandidate, decideConsent, getPublicationState, listMyConsentRequests, previewCandidate } from '../server/modules/publication/candidates'
import { getPublicPublication } from '../server/modules/publication/public-read'
import { publishCandidate } from '../server/modules/publication/releases'
import { createTask, listTasks } from '../server/modules/tasks/tasks'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'
import { memberRef } from './helpers-space-member-ref'

const T0 = new Date('2026-11-06T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const ROOM_SENTINEL = 'STUDYROOMSENT'

type Mode = 'real' | 'display' | 'anonymous'

async function student(tx: DbExecutor, schoolId: string, name: string) {
  const u = await createUser(tx, { displayName: name, handle: `s${rand()}` })
  const a = await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id, affiliationId: a.id }
}

/** 학교·지난 학기 과목·스터디 방(방장 + 초대 수락한 두 멤버). 방 이름에 센티넬. */
async function world(tx: DbExecutor, mode: Mode = 'display') {
  const t = rand()
  const founder = { userId: (await createUser(tx)).id }
  const school = await createSchool(tx, founder, { name: `기록대${t}학교`, confirmNew: true }, T0)
  const course = await createCourse(tx, founder, school.id, { title: `자료구조${t}`, code: `DS-${t}`, confirmNew: true }, T0)
  const { term } = await createCourseTerm(tx, founder, course.id, { year: 2025, semester: 'fall' }, T0)
  const owner = await student(tx, school.id, '방장김')
  const a = await student(tx, school.id, '멤버이')
  const b = await student(tx, school.id, '멤버박')
  const room = await createStudyRoomInternal(tx, { ownerId: owner.userId, name: `${ROOM_SENTINEL} 스터디`, schoolId: school.id, nameMode: mode, linkedCourseId: course.id }, T0)
  const invite = async (p: { userId: string }, n = 1) => {
    const { token } = await createSpaceInvitation(tx, owner, room.slug, at(n))
    await acceptSpaceInvitation(tx, p, { token }, at(n))
  }
  await invite(a)
  await invite(b)
  return { school, course, term, owner, a, b, room, invite }
}

async function roleOf(tx: DbExecutor, projectId: string, userId: string) {
  const rows = await tx.select({ userId: projectMembers.userId, role: projectMembers.role, status: projectMembers.status }).from(projectMembers).where(eq(projectMembers.projectId, projectId))
  const r = rows.find((x) => x.userId === userId)
  return r ? `${r.status}:${r.role}` : null
}

const eventsOf = async (tx: DbExecutor, userId: string) =>
  tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(analyticsPepper()!, userId)))

const ownerOf = async (tx: DbExecutor, projectId: string) => (await tx.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)))[0]!.ownerId

describe.skipIf(!databaseUrl)('C-08 study records (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => setAnalyticsEnvForTesting(null))

  it('only the study room owner enables the record; it creates a linked study project with derived members and no room text', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'study-record-analytics-pepper-for-tests-0123456789' })
      const w = await world(tx)
      expect(await getStudyRecord(tx, w.a, w.room.slug)).toMatchObject({ available: true, enabled: false, canEnable: false, projectId: null })
      expect((await getStudyRecord(tx, w.owner, w.room.slug)).canEnable).toBe(true)
      await expectServiceError(enableStudyRecord(tx, w.a, w.room.slug, {}, at(2)), 'FORBIDDEN')
      await expectServiceError(enableStudyRecord(tx, w.owner, w.room.slug, { courseTermId: crypto.randomUUID() }, at(2)), 'VALIDATION')

      const state = await enableStudyRecord(tx, w.owner, w.room.slug, { courseTermId: w.term.id }, at(2))
      expect(state).toMatchObject({ available: true, enabled: true, myRole: 'owner', canEnable: false, nameMode: 'display', portfolioLinkable: true })
      const projectId = state.projectId!
      await expectServiceError(enableStudyRecord(tx, w.owner, w.room.slug, {}, at(3)), 'CONFLICT', 'already_enabled')

      const [link] = await tx.select().from(studyRecords).where(eq(studyRecords.spaceId, w.room.id))
      expect(link).toMatchObject({ projectId, enabledBy: w.owner.userId })
      const project = await getProject(tx, w.owner, projectId, at(3))
      expect(project).toMatchObject({ kind: 'study', studyNameMode: 'display', myRole: 'owner', courseTermId: w.term.id, visibility: 'private' })
      expect(project.title).toBe(`${w.course.title} 스터디 기록`)
      expect(JSON.stringify(project)).not.toContain(ROOM_SENTINEL)
      expect(await roleOf(tx, projectId, w.owner.userId)).toBe('active:owner')
      expect(await roleOf(tx, projectId, w.a.userId)).toBe('active:editor')
      expect(await roleOf(tx, projectId, w.b.userId)).toBe('active:editor')
      expect((await getStudyRecord(tx, w.a, w.room.slug)).myRole).toBe('editor')
      // 내 과제 목록에도 kind study로 들어 있음(화면이 "스터디 기록"으로 따로 묶음)
      expect((await listMyProjects(tx, w.a)).find((p) => p.id === projectId)?.kind).toBe('study')

      // 사용자 방에서는 켤 수 없음
      const userRoom = await createRoom(tx, w.owner, { name: `방${rand()}`, nameMode: 'display', schoolId: w.school.id, joinPolicy: 'open', discovery: 'listed' }, at(3))
      await expectServiceError(enableStudyRecord(tx, w.owner, userRoom.slug, {}, at(3)), 'CONFLICT', 'not_study_room')
      expect((await getStudyRecord(tx, w.owner, userRoom.slug)).available).toBe(false)

      // 감사·분석: id·코드만
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, w.room.id))
      const enable = audits.find((e) => e.action === 'community.study_record_enable')!
      expect(Object.keys(enable.metadata as object).sort()).toEqual(['mode', 'withCourse'])
      const events = await eventsOf(tx, w.owner.userId)
      expect(events.find((e) => e.name === 'study_record_enabled')?.props).toEqual({ mode: 'display', withCourse: true })
      expect(events.find((e) => e.name === 'project_created')?.props).toMatchObject({ kind: 'study', origin: 'study' })
    })
  })

  it('derives membership from the room: join, leave, remove, re-invite, role change, owner transfer, succession, archive', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const projectId = (await enableStudyRecord(tx, w.owner, w.room.slug, {}, at(2))).projectId!

      // 기록을 켠 뒤 초대를 수락한 사람도 editor로 들어옴(조인 경로) → 로그를 씀
      const c = await student(tx, w.school.id, '새멤버')
      await w.invite(c, 3)
      expect(await roleOf(tx, projectId, c.userId)).toBe('active:editor')
      await createLog(tx, c, projectId, { tag: 'progress', body: '1주차: 스택 정리', links: [] }, at(3))

      // 나가기 → left → 404
      await leaveSpace(tx, c, w.room.slug, at(4))
      expect(await roleOf(tx, projectId, c.userId)).toBe('left:editor')
      await expectServiceError(getProject(tx, c, projectId, at(4)), 'NOT_FOUND')
      await expectServiceError(createLog(tx, c, projectId, { tag: 'progress', body: '나간 뒤', links: [] }, at(4)), 'NOT_FOUND')

      // 내보내기 → removed → 404, 새 초대로 다시 들어오면 같은 행이 active로 돌아옴
      await removeSpaceMember(tx, w.owner, w.room.slug, await memberRef(tx, w.room.slug, w.b.userId), at(5))
      expect(await roleOf(tx, projectId, w.b.userId)).toBe('removed:editor')
      await expectServiceError(listLogs(tx, w.b, projectId, {}), 'NOT_FOUND')
      await w.invite(w.b, 6)
      expect(await roleOf(tx, projectId, w.b.userId)).toBe('active:editor')
      const rows = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, projectId))
      expect(rows.filter((r) => r.userId === w.b.userId)).toHaveLength(1)

      // 방 역할 admin → 과제는 그대로 editor
      await changeSpaceRole(tx, w.owner, w.room.slug, await memberRef(tx, w.room.slug, w.a.userId), { role: 'admin' }, at(7))
      expect(await roleOf(tx, projectId, w.a.userId)).toBe('active:editor')

      // 과제 쪽 멤버 관리는 409 study_managed(원천은 방 하나)
      await expectServiceError(createInvitation(tx, w.owner, projectId, { role: 'editor' }, at(7)), 'CONFLICT', 'study_managed')
      await expectServiceError(changeMemberRole(tx, w.owner, projectId, w.a.userId, { role: 'viewer' }), 'CONFLICT', 'study_managed')
      await expectServiceError(removeMember(tx, w.owner, projectId, w.a.userId), 'CONFLICT', 'study_managed')
      await expectServiceError(leaveProject(tx, w.a, projectId), 'CONFLICT', 'study_managed')
      await expectServiceError(transferOwnership(tx, w.owner, projectId, { userId: w.a.userId }), 'CONFLICT', 'study_managed')
      const version = (await getProject(tx, w.owner, projectId, at(7))).version
      await expectServiceError(updateProject(tx, w.owner, projectId, { expectedVersion: version, kind: 'team' }, at(7)), 'CONFLICT', 'study_managed')
      expect(await roleOf(tx, projectId, w.a.userId)).toBe('active:editor')

      // 방장 넘기기(역할 owner) → 과제 owner도 바뀜, 이전 방장은 editor
      await changeSpaceRole(tx, w.owner, w.room.slug, await memberRef(tx, w.room.slug, w.a.userId), { role: 'owner' }, at(8))
      expect(await ownerOf(tx, projectId)).toBe(w.a.userId)
      expect(await roleOf(tx, projectId, w.a.userId)).toBe('active:owner')
      expect(await roleOf(tx, projectId, w.owner.userId)).toBe('active:editor')

      // 방장이 나가면 승계(가장 오래된 admin(이전 방장) → 없으면 가장 오래된 멤버) → 과제 owner도 승계자
      // ADR 0060 D-10: 방을 떠나 기록에서 나간 멤버의 AI 회고 켜기 행도 같은 트랜잭션에서 지웁니다.
      await tx.insert(aiRetroOptIns).values({ projectId, userId: w.a.userId })
      await leaveSpace(tx, w.a, w.room.slug, at(9))
      expect(await tx.select().from(aiRetroOptIns).where(eq(aiRetroOptIns.userId, w.a.userId))).toEqual([])
      expect(await ownerOf(tx, projectId)).toBe(w.owner.userId)
      expect(await roleOf(tx, projectId, w.owner.userId)).toBe('active:owner')
      expect(await roleOf(tx, projectId, w.a.userId)).toBe('left:editor')

      // 보관 → 방장 외 viewer(읽기만): 로그 403, 읽기는 됨. 방장은 owner(공개 준비 가능)
      await archiveSpace(tx, w.owner, w.room.slug, at(10))
      expect(await roleOf(tx, projectId, w.b.userId)).toBe('active:viewer')
      expect((await listLogs(tx, w.b, projectId, {})).items.length).toBeGreaterThan(0)
      await expectServiceError(createLog(tx, w.b, projectId, { tag: 'progress', body: '보관 뒤', links: [] }, at(10)), 'FORBIDDEN')
      expect(await roleOf(tx, projectId, w.owner.userId)).toBe('active:owner')

      // 남은 사람이 모두 나가면 모두 left(과제 owner_id는 마지막 방장 그대로, 기록은 남음)
      await leaveSpace(tx, w.b, w.room.slug, at(11))
      await leaveSpace(tx, w.owner, w.room.slug, at(11))
      const after = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, projectId))
      expect(after.every((m) => m.status !== 'active')).toBe(true)
      expect(after.some((m) => m.role === 'owner')).toBe(false)
      const [space] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, w.room.id))
      expect(space!.status).toBe('archived')
      const syncs = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, projectId))
      for (const e of syncs.filter((x) => x.action === 'project.study_sync')) expect(Object.keys(e.metadata as object).sort()).toEqual(['inserted', 'ownerChanged', 'updated'])
    })
  })

  it('non-members, other schools, unverified, left, removed and affiliation-revoked members get 404 on the study project and everything in it', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const projectId = (await enableStudyRecord(tx, w.owner, w.room.slug, {}, at(2))).projectId!
      const log = (await createLog(tx, w.a, projectId, { tag: 'progress', body: '기록', links: [] }, at(3))).log
      await createMilestone(tx, w.a, projectId, { title: '1주차' }, at(3))
      await createTask(tx, w.a, projectId, { title: '스택 문제 풀기' }, at(3))
      const other = await createSchool(tx, w.owner, { name: `남의${rand()}학교`, confirmNew: true }, T0)
      const left = await student(tx, w.school.id, '나간사람')
      const removed = await student(tx, w.school.id, '내보낸사람')
      for (const p of [left, removed]) await w.invite(p, 4)
      await leaveSpace(tx, left, w.room.slug, at(5))
      await removeSpaceMember(tx, w.owner, w.room.slug, await memberRef(tx, w.room.slug, removed.userId), at(5))
      // 학교 인증을 해제한 멤버(방 멤버십은 그대로): C-05처럼 다음 요청부터 404
      await removeAffiliation(tx, w.b, w.b.affiliationId, at(6))
      const actors = {
        sameSchoolNonMember: await student(tx, w.school.id, '바깥'),
        otherSchool: await student(tx, other.id, '남의학교'),
        unverified: { userId: (await createUser(tx)).id },
        left,
        removed,
        revoked: w.b,
      }
      const ops: Record<string, (a: { userId: string }) => Promise<unknown>> = {
        'GET projects/:id': (a) => getProject(tx, a, projectId, at(7)),
        'GET logs': (a) => listLogs(tx, a, projectId, {}),
        'POST logs': (a) => createLog(tx, a, projectId, { tag: 'progress', body: 'x', links: [] }, at(7)),
        'GET milestones': (a) => listMilestones(tx, a, projectId),
        'GET tasks': (a) => listTasks(tx, a, projectId, {}),
        'GET artifacts': (a) => listArtifacts(tx, a, projectId),
        'GET members': (a) => listMembers(tx, a, projectId),
        'GET publication': (a) => getPublicationState(tx, a, projectId, at(7)),
        'GET study-record': (a) => getStudyRecord(tx, a, w.room.slug),
      }
      const cells: string[] = []
      for (const [name, actor] of Object.entries(actors)) {
        for (const [label, op] of Object.entries(ops)) {
          const err = await op(actor).then(
            () => null,
            (e: { code?: string; reason?: string }) => e,
          )
          if (err?.code !== 'NOT_FOUND') cells.push(`${name} × ${label}: ${err ? `${err.code}/${err.reason}` : 'ok'}`)
        }
        expect((await listMyProjects(tx, actor)).map((p) => p.id), name).not.toContain(projectId)
      }
      expect(cells).toEqual([])
      // 멤버는 그대로 읽음
      expect((await listLogs(tx, w.a, projectId, {})).items.map((l) => l.id)).toContain(log.id)
      // 인증을 다시 하면 돌아옴
      await verifiedAffiliation(tx, w.b.userId, w.school.id)
      expect((await getProject(tx, w.b, projectId, at(8))).kind).toBe('study')
    })
  })

  it('publishes through candidate → every room member consents → publish; snapshot, public page and course hub say study', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'study-record-analytics-pepper-for-tests-0123456789' })
      const w = await world(tx, 'display')
      const projectId = (await enableStudyRecord(tx, w.owner, w.room.slug, { courseTermId: w.term.id }, at(2))).projectId!
      const log = (await createLog(tx, w.a, projectId, { tag: 'progress', body: '3주차: 그래프 탐색 정리', links: [] }, at(3))).log
      const milestone = await createMilestone(tx, w.a, projectId, { title: '그래프 주간' }, at(3))
      const slug = `study-${rand().slice(0, 8)}`
      const candidate = await createCandidate(
        tx,
        w.owner,
        projectId,
        { level: 'summary', title: '자료구조 스터디 회고', summary: '8주 동안 함께 정리했다.', slug, logIds: [log.id], milestoneIds: [milestone.id], exposure: { [w.a.userId]: 'name' }, consentSelf: true },
        at(4),
        ORIGINS,
      )
      // b는 내용이 없어도 방 멤버라 당사자(study_member)
      const subjects = new Map(candidate.subjects.map((s) => [s.userId, s]))
      expect([...subjects.keys()].sort()).toEqual([w.owner.userId, w.a.userId, w.b.userId].sort())
      expect(subjects.get(w.b.userId)!.scope).toEqual(['study_member'])
      expect(subjects.get(w.a.userId)!.scope).toEqual(expect.arrayContaining(['logs', 'name', 'study_member']))
      expect(candidate.status).toBe('awaiting_consent')
      const preview = (await previewCandidate(tx, w.owner, candidate.id)).snapshot
      expect(preview.kind).toBe('study')
      expect(preview.studyNameMode).toBe('display')
      expect((await listMyConsentRequests(tx, w.b)).map((r) => r.candidateId)).toContain(candidate.id)

      const blocked = await expectServiceError(publishCandidate(tx, w.owner, candidate.id, { manifestHash: candidate.manifestHash }, at(5)), 'CONFLICT', 'publish_blocked')
      expect(JSON.stringify(blocked.details)).toContain(w.b.userId)
      await decideConsent(tx, w.a, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(5))
      await expectServiceError(publishCandidate(tx, w.owner, candidate.id, { manifestHash: candidate.manifestHash }, at(5)), 'CONFLICT', 'publish_blocked')
      await decideConsent(tx, w.b, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(6))
      const published = await publishCandidate(tx, w.owner, candidate.id, { manifestHash: candidate.manifestHash }, at(7))
      expect(published.release.version).toBe(1)

      const pub = await getPublicPublication(tx, slug, at(8))
      expect(pub.snapshot).toMatchObject({ kind: 'study', studyNameMode: 'display', title: '자료구조 스터디 회고' })
      expect(pub.snapshot.members.find((m) => !m.anonymous)?.label).toBe('멤버이')
      expect(JSON.stringify(pub)).not.toContain(ROOM_SENTINEL)
      const hub = await getPublicCourseHub(tx, w.course.id, at(8))
      const listed = hub.cases.find((c) => c.slug === slug)
      expect(listed).toMatchObject({ kind: 'study', title: '자료구조 스터디 회고' })
      expect(listed!.teamSize).toBe(1)
      expect((await eventsOf(tx, w.owner.userId)).find((e) => e.name === 'publication_published')?.props).toMatchObject({ origin: 'study' })
      expect((await eventsOf(tx, w.a.userId)).find((e) => e.name === 'log_saved')?.props).toMatchObject({ origin: 'study' })

      // 표시명 방: 케이스 스터디(포트폴리오) 가능, 모집 첨부에도 나옴
      const cs = await createCaseStudy(tx, w.a, { releaseSlug: slug, jobTarget: 'backend' }, at(9))
      expect(cs.source.slug).toBe(slug)
      expect((await attachmentOptions(tx, w.a, at(9))).cases.map((c) => c.slug)).toContain(slug)

      // 방 방식이 나중에 익명으로 바뀌어도(worker가 공간·과제 두 열을 같은 트랜잭션에서 바꿈) 이미 게시한 release는 그대로
      await tx.update(communitySpaces).set({ currentNameMode: 'anonymous' }).where(eq(communitySpaces.id, w.room.id))
      await tx.update(projects).set({ studyNameMode: 'anonymous' }).where(eq(projects.id, projectId))
      const still = await getPublicPublication(tx, slug, at(10))
      expect(still.snapshot.studyNameMode).toBe('display')
      expect(still.snapshot.members.find((m) => !m.anonymous)?.label).toBe('멤버이')
      await createCaseStudy(tx, w.a, { releaseSlug: slug, jobTarget: 'general' }, at(10))
      // 새 후보는 지금 방식(익명): 이름 노출 422, 모두 익명이면 studyNameMode anonymous
      await expectServiceError(
        createCandidate(tx, w.owner, projectId, { level: 'summary', title: '다음 판', summary: '요약', slug, logIds: [log.id], exposure: { [w.a.userId]: 'name' } }, at(11), ORIGINS),
        'VALIDATION',
      )
      const next = await createCandidate(tx, w.owner, projectId, { level: 'summary', title: '다음 판', summary: '요약', slug, logIds: [log.id] }, at(11), ORIGINS)
      const nextSnapshot = (await previewCandidate(tx, w.owner, next.id)).snapshot
      expect(nextSnapshot.studyNameMode).toBe('anonymous')
      expect(nextSnapshot.members.every((m) => m.anonymous)).toBe(true)
    })
  })

  it('anonymous study room: names hidden inside the record and in the snapshot, case studies blocked with 422 anonymous_study, never linked to profiles or applications', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx, 'anonymous')
      const state = await enableStudyRecord(tx, w.owner, w.room.slug, { courseTermId: w.term.id }, at(2))
      expect(state).toMatchObject({ nameMode: 'anonymous', portfolioLinkable: false })
      const projectId = state.projectId!
      expect((await getProject(tx, w.a, projectId, at(2))).studyNameMode).toBe('anonymous')
      const log = (await createLog(tx, w.a, projectId, { tag: 'progress', body: '익명 방 기록', links: [] }, at(3))).log

      // 기록 안: 본인은 자기 이름, 다른 사람은 "스터디 멤버 N"(handle 없음)
      const seenByOwner = (await listLogs(tx, w.owner, projectId, {})).items.find((l) => l.id === log.id)!
      expect(seenByOwner.author.displayName).toMatch(/^스터디 멤버 \d$/)
      expect(seenByOwner.author.handle).toBeNull()
      expect((await listLogs(tx, w.a, projectId, {})).items.find((l) => l.id === log.id)!.author.displayName).toBe('멤버이')
      const members = await listMembers(tx, w.b, projectId)
      expect(members.find((m) => m.userId === w.b.userId)!.displayName).toBe('멤버박')
      for (const m of members.filter((x) => x.userId !== w.b.userId)) {
        expect(m.displayName).toMatch(/^스터디 멤버 \d$/)
        expect(m.handle).toBeNull()
        // 다른 멤버의 id도 과제별 가명 키(ADR 0026 부록)
        expect(m.userId).toMatch(/^sm_[0-9a-f]{16}$/)
      }
      expect(seenByOwner.author.userId).toMatch(/^sm_[0-9a-f]{16}$/)
      expect(JSON.stringify(members)).not.toMatch(/방장김|멤버이/)

      const slug = `anon-${rand().slice(0, 8)}`
      await expectServiceError(
        createCandidate(tx, w.owner, projectId, { level: 'summary', title: '익명 스터디', summary: '요약', slug, logIds: [log.id], exposure: { [w.a.userId]: 'name' } }, at(4), ORIGINS),
        'VALIDATION',
      ).then((e) => expect(e.fields).toEqual({ exposure: 'anonymous_study' }))
      const candidate = await createCandidate(
        tx,
        w.owner,
        projectId,
        // 노출 방식의 키는 멤버 가명 키(ADR 0026 부록): 방장이 보는 a의 키
        { level: 'summary', title: '익명 스터디', summary: '요약', slug, logIds: [log.id], exposure: { [seenByOwner.author.userId]: 'anonymous' }, consentSelf: true },
        at(4),
        ORIGINS,
      )
      const snap = (await previewCandidate(tx, w.owner, candidate.id)).snapshot
      expect(snap).toMatchObject({ kind: 'study', studyNameMode: 'anonymous' })
      expect(snap.members.every((m) => m.anonymous)).toBe(true)
      expect(snap.logs.every((l) => l.author === null)).toBe(true)
      // 방장 화면의 당사자 이름도 가림
      expect(candidate.subjects.filter((s) => s.userId !== w.owner.userId).every((s) => /^스터디 멤버 \d$/.test(s.displayName))).toBe(true)
      for (const p of [w.a, w.b]) await decideConsent(tx, p, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(5))
      await publishCandidate(tx, w.owner, candidate.id, { manifestHash: candidate.manifestHash }, at(6))
      const pub = await getPublicPublication(tx, slug, at(7))
      expect(JSON.stringify(pub)).not.toMatch(/방장김|멤버이|멤버박/)
      expect((await getPublicCourseHub(tx, w.course.id, at(7))).cases.find((c) => c.slug === slug)?.kind).toBe('study')

      const blocked = await expectServiceError(createCaseStudy(tx, w.a, { releaseSlug: slug, jobTarget: 'backend', revealSelf: true }, at(8)), 'VALIDATION', 'anonymous_study')
      expect(blocked.fields).toEqual({ releaseSlug: 'anonymous_study' })
      await expectServiceError(createCaseStudy(tx, w.owner, { releaseSlug: slug, jobTarget: 'backend', revealSelf: true }, at(8)), 'VALIDATION', 'anonymous_study')
      expect((await attachmentOptions(tx, w.a, at(8))).cases.map((c) => c.slug)).not.toContain(slug)

      // 방 방식이 표시명으로 바뀌어도 이 release는 익명으로 고정(포트폴리오 연결 불가 유지)
      await tx.update(communitySpaces).set({ currentNameMode: 'display' }).where(eq(communitySpaces.id, w.room.id))
      await tx.update(projects).set({ studyNameMode: 'display' }).where(eq(projects.id, projectId))
      await expectServiceError(createCaseStudy(tx, w.a, { releaseSlug: slug, jobTarget: 'backend', revealSelf: true }, at(9)), 'VALIDATION', 'anonymous_study')
    })
  })
})
