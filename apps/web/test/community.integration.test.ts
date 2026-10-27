/**
 * C-02 커뮤니티 공간·게시판·멤버십·가입 방식 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 DB 테스트는 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교(무작위 이름)·사용자만 봅니다. 마지막 describe는 DB 없이 도는 소스 경계 검사입니다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  OFFICIAL_REQUEST_THRESHOLD,
  type SpaceRole,
} from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  auditEvents,
  communitySpaces,
  eq,
  hashSubject,
  inArray,
  institutionAffiliations,
  moderationActions,
  operators,
  searchDocuments,
  spaceMemberships,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { analyticsPepper, setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { createSchool } from '../server/modules/catalog/catalog'
import { createSpaceInvitation, acceptSpaceInvitation, previewSpaceInvitation, revokeSpaceInvitation } from '../server/modules/community/invitations'
import {
  approveMember,
  changeMemberRole,
  joinSpace,
  leaveSpace,
  listMembers,
  rejectMember,
  removeMember,
} from '../server/modules/community/memberships'
import {
  archiveSpaceByOperator,
  assignModerator,
  createOfficialPage,
  decideCapacity,
  liftSpaceRestriction,
  listOfficialRequestGroups,
  listSpacesForOperator,
  markStudentCouncilRequest,
  requestOfficialPage,
  restrictSpace,
} from '../server/modules/community/official'
import {
  archiveSpace,
  createBoard,
  createRoom,
  createStudyRoomInternal,
  discoverSpaces,
  getSpaceDetail,
  listBoards,
  listMySpaces,
  updateBoard,
  updateSpace,
} from '../server/modules/community/spaces'
import { searchPublic } from '../server/modules/course-hub/search'
import { getReportDetail, resolveReport } from '../server/modules/moderation/operator'
import { createReport } from '../server/modules/moderation/reports'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-03T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

interface Fixture {
  op: { userId: string }
  schoolId: string
  schoolName: string
  otherSchoolId: string
}

async function fixture(tx: DbExecutor): Promise<Fixture> {
  const op = { userId: (await createUser(tx)).id }
  await tx.insert(operators).values({ userId: op.userId })
  const t = token()
  const school = await createSchool(tx, op, { name: `커뮤대${t}학교`, confirmNew: true }, T0)
  const other = await createSchool(tx, op, { name: `다른대${t}학교`, confirmNew: true }, T0)
  return { op, schoolId: school.id, schoolName: school.name, otherSchoolId: other.id }
}

/** 그 학교 active 인증이 있는 사용자. */
async function student(tx: DbExecutor, schoolId: string, departmentLabel: string | null = null): Promise<{ userId: string }> {
  const u = await createUser(tx, { handle: `c${token()}` })
  await verifiedAffiliation(tx, u.id, schoolId, { departmentLabel })
  return { userId: u.id }
}

const roomInput = (overrides: Record<string, unknown> = {}) => ({ name: `스터디방 ${token()}`, nameMode: 'display', ...overrides })

describe.skipIf(!databaseUrl)('community spaces (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => setAnalyticsEnvForTesting(null))

  it('only operators open official pages: badge, fixed anonymous mode, default boards, one per school/department', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const s = await student(tx, f.schoolId)
      await expectServiceError(createOfficialPage(tx, s, { schoolId: f.schoolId }), 'FORBIDDEN', 'operator_only')
      // 사용자 방 만들기 입력에 kind를 넣어도 공식 페이지가 되지 않음(무시)
      const room = await createRoom(tx, s, { ...roomInput(), kind: 'official_school' }, T0)
      expect(room).toMatchObject({ kind: 'user_room', official: false })

      const page = await createOfficialPage(tx, f.op, { schoolId: f.schoolId }, T0)
      expect(page).toMatchObject({ kind: 'official_school', official: true, nameMode: 'anonymous', name: f.schoolName, memberCount: null, capacity: null })
      expect(page.boards.map((b) => [b.kind, b.writeRole])).toEqual([
        ['free', 'member'],
        ['freshmen', 'member'],
        ['alumni', 'member'],
        ['question', 'member'],
        ['info', 'member'],
        ['recruiting', 'member'],
        ['notice', 'moderator'],
      ])
      await expectServiceError(createOfficialPage(tx, f.op, { schoolId: f.schoolId }, T0), 'CONFLICT', 'official_exists')
      const dept = await createOfficialPage(tx, f.op, { schoolId: f.schoolId, departmentLabel: '컴퓨터공학과' }, T0)
      expect(dept).toMatchObject({ kind: 'official_department', departmentLabel: '컴퓨터공학과', name: `${f.schoolName} 컴퓨터공학과` })
      // 띄어쓰기만 다른 같은 학과는 같은 페이지
      await expectServiceError(createOfficialPage(tx, f.op, { schoolId: f.schoolId, departmentLabel: '컴퓨터 공학과' }, T0), 'CONFLICT', 'official_exists')
      // 공식 페이지는 가입·초대·멤버 목록이 없음, 이름 표시 방식은 바꿀 수 없음
      await expectServiceError(joinSpace(tx, s, page.slug), 'CONFLICT', 'not_joinable')
      await expectServiceError(createSpaceInvitation(tx, f.op, page.slug), 'CONFLICT', 'not_joinable')
      await expectServiceError(listMembers(tx, s, page.slug), 'CONFLICT', 'no_member_list')
      await expectServiceError(updateSpace(tx, f.op, page.slug, { nameMode: 'real' }), 'VALIDATION')
      await expectServiceError(updateSpace(tx, f.op, page.slug, { joinPolicy: 'approval' }), 'VALIDATION')
      await expectServiceError(updateSpace(tx, s, page.slug, { name: '바꾼 이름' }), 'FORBIDDEN')
      // 운영자는 공식 페이지 이름에 예약어를 쓸 수 있음(공식 페이지 자체가 공식)
      expect((await updateSpace(tx, f.op, page.slug, { name: `${f.schoolName} 공식` }, at(1))).name).toBe(`${f.schoolName} 공식`)
      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.official_create'), eq(auditEvents.actorId, f.op.userId)))
      expect(audit).toHaveLength(2)
    })
  })

  it('derives official-page access from an active affiliation: other school, unverified and revoked users get 404', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const page = await createOfficialPage(tx, f.op, { schoolId: f.schoolId }, T0)
      const dept = await createOfficialPage(tx, f.op, { schoolId: f.schoolId, departmentLabel: '컴퓨터공학과' }, T0)
      const member = await student(tx, f.schoolId, '컴퓨터 공학과')
      const business = await student(tx, f.schoolId, '경영학과')
      const outsider = await student(tx, f.otherSchoolId)
      const unverified = { userId: (await createUser(tx)).id }

      const seen = await getSpaceDetail(tx, member, page.slug)
      expect(seen.access).toBe('member')
      expect(seen.boards.find((b) => b.kind === 'free')?.canWrite).toBe(true)
      expect(seen.boards.find((b) => b.kind === 'notice')?.canWrite).toBe(false)
      expect(seen.myMembership).toBeNull()
      for (const who of [outsider, unverified]) {
        await expectServiceError(getSpaceDetail(tx, who, page.slug), 'NOT_FOUND')
        await expectServiceError(listBoards(tx, who, page.slug), 'NOT_FOUND')
        await expectServiceError(getSpaceDetail(tx, who, dept.slug), 'NOT_FOUND')
      }
      // 학과 페이지: 같은 학교면 읽고, 같은 학과(키)만 씀
      expect((await getSpaceDetail(tx, business, dept.slug)).boards.every((b) => !b.canWrite)).toBe(true)
      expect((await getSpaceDetail(tx, member, dept.slug)).boards.find((b) => b.kind === 'free')?.canWrite).toBe(true)
      // 내 공간·찾기에 내 학교 공식 페이지만
      const mine = await listMySpaces(tx, member)
      expect(mine.items.map((i) => i.slug).sort()).toEqual([page.slug, dept.slug].sort())
      expect((await listMySpaces(tx, outsider)).items.map((i) => i.slug)).not.toContain(page.slug)
      expect((await discoverSpaces(tx, outsider, {})).map((i) => i.slug)).not.toContain(page.slug)
      expect(await discoverSpaces(tx, unverified, {})).toEqual([])

      // 모더레이터 지정(운영자, 그 학교 인증 필요) → 공지 쓰기 자격
      await expectServiceError(assignModerator(tx, f.op, page.slug, { userId: outsider.userId }), 'VALIDATION')
      await assignModerator(tx, f.op, page.slug, { userId: member.userId }, at(1))
      expect((await getSpaceDetail(tx, member, page.slug)).boards.find((b) => b.kind === 'notice')?.canWrite).toBe(true)
      expect((await getSpaceDetail(tx, member, page.slug)).permissions.moderate).toBe(true)

      // 인증 해제 → 다음 요청부터 404(모더레이터 멤버십이 있어도)
      await tx.update(institutionAffiliations).set({ status: 'revoked', revokedAt: at(2), revokedReason: 'operator', emailHash: null }).where(eq(institutionAffiliations.userId, member.userId))
      await expectServiceError(getSpaceDetail(tx, member, page.slug), 'NOT_FOUND')
      // 운영자는 공식 페이지를 읽음(관리), 사용자 방은 못 읽음(아래 테스트)
      expect((await getSpaceDetail(tx, f.op, page.slug)).permissions.manageBoards).toBe(true)
      // 형식이 틀린 주소·없는 주소도 같은 404
      await expectServiceError(getSpaceDetail(tx, business, '../../etc'), 'NOT_FOUND')
      await expectServiceError(getSpaceDetail(tx, business, 'zzzzzzzzzz'), 'NOT_FOUND')
    })
  })

  it('creates user rooms only with an affiliation; rejects reserved names; caps capacity at 300 with operator review', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const s = await student(tx, f.schoolId)
      const unverified = { userId: (await createUser(tx)).id }
      const e = await expectServiceError(createRoom(tx, unverified, roomInput(), T0), 'FORBIDDEN', 'affiliation_required')
      expect(e.details).toMatchObject({ requirement: 'school_affiliation' })
      await expectServiceError(createRoom(tx, s, roomInput({ schoolId: f.otherSchoolId }), T0), 'FORBIDDEN', 'affiliation_required')
      await expectServiceError(createRoom(tx, s, roomInput({ schoolId: crypto.randomUUID() }), T0), 'NOT_FOUND')
      for (const name of ['공식 컴공방', '총학생회 공지방', '운영자 모임', 'Peerchive 팬', '관 리 자']) {
        const err = await expectServiceError(createRoom(tx, s, roomInput({ name }), T0), 'VALIDATION')
        expect(err.fields).toEqual({ name: 'reserved' })
      }
      expect((await expectServiceError(createRoom(tx, s, roomInput({ name: '' }), T0), 'VALIDATION')).fields).toEqual({ name: 'required' })
      expect((await expectServiceError(createRoom(tx, s, roomInput({ nameMode: 'secret' }), T0), 'VALIDATION')).fields).toEqual({ nameMode: 'invalid' })
      expect((await expectServiceError(createRoom(tx, s, roomInput({ capacity: 1 }), T0), 'VALIDATION')).fields).toEqual({ capacity: 'too_small' })

      setAnalyticsEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'community-analytics-pepper-for-tests-0123456789' })
      const room = await createRoom(tx, s, roomInput({ name: '운영체제 스터디', capacity: 500, schoolId: f.schoolId, nameMode: 'real' }), T0)
      expect(room).toMatchObject({
        kind: 'user_room',
        official: false,
        name: '운영체제 스터디',
        nameMode: 'real',
        joinPolicy: 'approval', // 실명 방은 승인이 기본
        capacity: 300,
        capacityRequested: 500,
        memberCount: 1,
        myMembership: { role: 'owner', status: 'active' },
        school: { id: f.schoolId },
      })
      expect(room.slug).toMatch(/^[a-z0-9]{10}$/)
      expect(room.boards.map((b) => [b.kind, b.title, b.canWrite])).toEqual([['general', '게시판', true]])
      // 분석 이벤트: 종류만, 공간 id·이름·학교 없음
      const events = await tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(analyticsPepper()!, s.userId)))
      expect(events.map((x) => [x.name, x.props])).toEqual([['space_created', { kind: 'user_room' }]])
      expect(JSON.stringify(events)).not.toContain(room.slug)

      // 운영자 정원 검토
      const pending = await listSpacesForOperator(tx, f.op, { capacityRequested: '1' })
      expect(pending.map((p) => p.slug)).toContain(room.slug)
      const id = pending.find((p) => p.slug === room.slug)!.id
      await expectServiceError(decideCapacity(tx, s, id, { capacity: 500 }), 'FORBIDDEN', 'operator_only')
      expect(await decideCapacity(tx, f.op, id, { capacity: 450 }, at(1))).toMatchObject({ capacity: 450, capacityRequested: null })
      // 운영자 목록에는 공간 정보만(게시판·멤버 없음), 운영자는 방 내용을 읽지 못함
      expect(Object.keys(pending[0]!)).not.toContain('boards')
      await expectServiceError(getSpaceDetail(tx, f.op, room.slug), 'NOT_FOUND')
      // 이름 표시 방식은 C-03에서
      expect((await expectServiceError(updateSpace(tx, s, room.slug, { nameMode: 'anonymous' }), 'VALIDATION')).fields).toEqual({ nameMode: 'not_editable' })
      expect((await expectServiceError(updateSpace(tx, s, room.slug, { name: '학생회 방' }), 'VALIDATION')).fields).toEqual({ name: 'reserved' })
      expect(await updateSpace(tx, s, room.slug, { description: '매주 목요일', discovery: 'unlisted' }, at(2))).toMatchObject({ description: '매주 목요일', discovery: 'unlisted' })
    })
  })

  it('join policies: open, approval (approve/reject), invite-only with single-use, revocable invites; school-linked rooms', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      const a = await student(tx, f.schoolId)
      const b = await student(tx, f.schoolId)
      const c = await student(tx, f.schoolId)
      const outsider = await student(tx, f.otherSchoolId)

      const open = await createRoom(tx, owner, roomInput({ joinPolicy: 'open' }), T0)
      expect((await getSpaceDetail(tx, a, open.slug))).toMatchObject({ access: 'preview', boards: [], joinAction: 'join', memberCount: 1 })
      expect(await joinSpace(tx, a, open.slug, at(1))).toMatchObject({ status: 'active' })
      expect((await getSpaceDetail(tx, a, open.slug)).access).toBe('member')
      await expectServiceError(joinSpace(tx, a, open.slug), 'CONFLICT', 'already_member')
      // 학교 무관 방은 다른 학교 인증 계정도 들어옴, 인증 없는 계정은 404
      expect(await joinSpace(tx, outsider, open.slug, at(1))).toMatchObject({ status: 'active' })
      await expectServiceError(joinSpace(tx, { userId: (await createUser(tx)).id }, open.slug), 'NOT_FOUND')

      const approval = await createRoom(tx, owner, roomInput({ joinPolicy: 'approval', schoolId: f.schoolId }), T0)
      await expectServiceError(getSpaceDetail(tx, outsider, approval.slug), 'NOT_FOUND')
      await expectServiceError(joinSpace(tx, outsider, approval.slug), 'NOT_FOUND')
      expect(await joinSpace(tx, a, approval.slug, at(2))).toMatchObject({ status: 'pending' })
      expect(await getSpaceDetail(tx, a, approval.slug)).toMatchObject({ access: 'preview', joinAction: 'pending' })
      await expectServiceError(joinSpace(tx, a, approval.slug), 'CONFLICT', 'already_pending')
      await joinSpace(tx, b, approval.slug, at(2))
      await expectServiceError(approveMember(tx, a, approval.slug, b.userId), 'NOT_FOUND') // 대기 중인 사람은 방을 읽지 못함
      const afterApprove = await approveMember(tx, owner, approval.slug, a.userId, at(3))
      expect(afterApprove.members.map((m) => m.userId)).toContain(a.userId)
      await expectServiceError(approveMember(tx, a, approval.slug, b.userId), 'FORBIDDEN') // 일반 멤버
      const afterReject = await rejectMember(tx, owner, approval.slug, b.userId, at(3))
      expect(afterReject.pending).toEqual([])
      await expectServiceError(approveMember(tx, owner, approval.slug, b.userId), 'CONFLICT', 'not_pending')
      // 거절된 사람은 소개도 404, 스스로 다시 요청할 수 없음(403 removed)
      await expectServiceError(getSpaceDetail(tx, b, approval.slug), 'NOT_FOUND')
      await expectServiceError(joinSpace(tx, b, approval.slug), 'FORBIDDEN', 'removed')

      const invite = await createRoom(tx, owner, roomInput({ joinPolicy: 'invite', discovery: 'unlisted', schoolId: f.schoolId }), T0)
      await expectServiceError(getSpaceDetail(tx, c, invite.slug), 'NOT_FOUND')
      await expectServiceError(joinSpace(tx, c, invite.slug), 'FORBIDDEN', 'invite_only')
      await expectServiceError(createSpaceInvitation(tx, a, invite.slug), 'NOT_FOUND')
      const { token: t1 } = await createSpaceInvitation(tx, owner, invite.slug, at(4))
      expect(await previewSpaceInvitation(tx, c, t1, at(5))).toMatchObject({ acceptable: true, reason: 'ok', space: { slug: invite.slug } })
      // C-05: 학교 자격이 없으면 토큰이 있어도 방 이름·소개 없이 404 not_eligible
      await expectServiceError(previewSpaceInvitation(tx, outsider, t1, at(5)), 'NOT_FOUND', 'not_eligible')
      await expectServiceError(acceptSpaceInvitation(tx, outsider, { token: t1 }, at(5)), 'NOT_FOUND') // 다른 학교 인증(토큰은 남음)
      expect(await acceptSpaceInvitation(tx, c, { token: t1 }, at(5))).toMatchObject({ status: 'active', space: { slug: invite.slug } })
      await expectServiceError(acceptSpaceInvitation(tx, a, { token: t1 }, at(6)), 'GONE') // 한 번만
      await expectServiceError(previewSpaceInvitation(tx, a, t1, at(6)), 'GONE')
      const { token: t2, invitation } = await createSpaceInvitation(tx, owner, invite.slug, at(6))
      await expectServiceError(acceptSpaceInvitation(tx, c, { token: t2 }, at(7)), 'CONFLICT', 'already_member') // 토큰은 쓰지 않음
      await revokeSpaceInvitation(tx, owner, invite.slug, invitation.id, at(7))
      await expectServiceError(acceptSpaceInvitation(tx, a, { token: t2 }, at(8)), 'GONE')
      const { token: t3 } = await createSpaceInvitation(tx, owner, invite.slug, at(8))
      await expectServiceError(acceptSpaceInvitation(tx, a, { token: t3 }, new Date(at(8).getTime() + 8 * 24 * 3600_000)), 'GONE') // 7일 만료
      await expectServiceError(acceptSpaceInvitation(tx, a, { token: 'short' }, at(8)), 'GONE')
      // 거절당한 사람도 새 초대로는 들어옴
      const { token: t4 } = await createSpaceInvitation(tx, owner, approval.slug, at(9))
      expect(await acceptSpaceInvitation(tx, b, { token: t4 }, at(9))).toMatchObject({ status: 'active' })

      // 찾기: listed 방만, 초대 전용·다른 학교 연결 방은 빠짐
      const found = (await discoverSpaces(tx, c, {})).map((s) => s.slug)
      expect(found).toEqual(expect.arrayContaining([open.slug, approval.slug]))
      expect(found).not.toContain(invite.slug)
      expect((await discoverSpaces(tx, outsider, {})).map((s) => s.slug)).not.toContain(approval.slug)
      expect((await discoverSpaces(tx, c, { q: open.name })).map((s) => s.slug)).toEqual([open.slug])
    })
  })

  it('enforces capacity on join, approval and invites', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      const [a, b, c] = [await student(tx, f.schoolId), await student(tx, f.schoolId), await student(tx, f.schoolId)]
      const room = await createRoom(tx, owner, roomInput({ capacity: 2 }), T0)
      await joinSpace(tx, a, room.slug, at(1))
      await expectServiceError(joinSpace(tx, b, room.slug, at(2)), 'CONFLICT', 'space_full')
      const { token: t } = await createSpaceInvitation(tx, owner, room.slug, at(2))
      expect(await previewSpaceInvitation(tx, b, t, at(2))).toMatchObject({ acceptable: false, reason: 'full' })
      await expectServiceError(acceptSpaceInvitation(tx, b, { token: t }, at(2)), 'CONFLICT', 'space_full')
      await updateSpace(tx, owner, room.slug, { joinPolicy: 'approval' }, at(3))
      expect(await joinSpace(tx, c, room.slug, at(3))).toMatchObject({ status: 'pending' })
      await expectServiceError(approveMember(tx, owner, room.slug, c.userId, at(4)), 'CONFLICT', 'space_full')
      await leaveSpace(tx, a, room.slug, at(5))
      await approveMember(tx, owner, room.slug, c.userId, at(6))
    })
  })

  it('succession on owner leave: oldest admin → oldest member → archive; archived rooms are read-only', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      const [m1, m2, adm1, adm2] = [await student(tx, f.schoolId), await student(tx, f.schoolId), await student(tx, f.schoolId), await student(tx, f.schoolId)]
      const room = await createRoom(tx, owner, roomInput(), T0)
      await joinSpace(tx, m1, room.slug, at(1))
      await joinSpace(tx, adm1, room.slug, at(2))
      await joinSpace(tx, adm2, room.slug, at(3))
      await joinSpace(tx, m2, room.slug, at(4))
      await changeMemberRole(tx, owner, room.slug, adm2.userId, { role: 'admin' }, at(5))
      await changeMemberRole(tx, owner, room.slug, adm1.userId, { role: 'admin' }, at(6))

      expect(await leaveSpace(tx, owner, room.slug, at(7))).toEqual({ left: true, succession: 'transferred' })
      const roleOf = async (userId: string) =>
        (await tx.select().from(spaceMemberships).where(and(eq(spaceMemberships.userId, userId), eq(spaceMemberships.spaceId, (await tx.select().from(communitySpaces).where(eq(communitySpaces.slug, room.slug)))[0]!.id))))[0]
      expect(await roleOf(adm1.userId)).toMatchObject({ role: 'owner', status: 'active' }) // 가장 먼저 들어온 admin(가입 시각 기준)
      expect(await roleOf(owner.userId)).toMatchObject({ status: 'left', role: 'member' })
      expect((await getSpaceDetail(tx, owner, room.slug)).access).toBe('preview') // 나간 사람은 다시 소개만

      await leaveSpace(tx, adm1, room.slug, at(8)) // → adm2
      expect(await roleOf(adm2.userId)).toMatchObject({ role: 'owner' })
      await leaveSpace(tx, adm2, room.slug, at(9)) // admin 없음 → 가장 오래된 멤버 m1
      expect(await roleOf(m1.userId)).toMatchObject({ role: 'owner' })
      await leaveSpace(tx, m2, room.slug, at(10))
      expect(await leaveSpace(tx, m1, room.slug, at(11))).toEqual({ left: true, succession: 'archived' })
      const [row] = await tx.select().from(communitySpaces).where(eq(communitySpaces.slug, room.slug))
      expect(row).toMatchObject({ status: 'archived' })
      await expectServiceError(joinSpace(tx, m2, room.slug), 'NOT_FOUND')
      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, row!.id), eq(auditEvents.action, 'community.owner_succession')))
      expect(audit).toHaveLength(3)

      // 보관된 방: 멤버는 읽기만, 관리·쓰기 없음
      const other = await createRoom(tx, owner, roomInput(), T0)
      await joinSpace(tx, m2, other.slug, at(12))
      await expectServiceError(archiveSpace(tx, m2, other.slug), 'FORBIDDEN')
      const archived = await archiveSpace(tx, owner, other.slug, at(13))
      expect(archived).toMatchObject({ status: 'archived', permissions: { manage: false, archive: false } })
      expect(archived.boards.every((b) => !b.canWrite)).toBe(true)
      expect((await getSpaceDetail(tx, m2, other.slug)).access).toBe('member')
      await expectServiceError(updateSpace(tx, owner, other.slug, { name: '새 이름' }), 'CONFLICT', 'space_not_active')
      await expectServiceError(createSpaceInvitation(tx, owner, other.slug), 'CONFLICT', 'space_not_active')
    })
  })

  it('role changes: only the owner; ownership transfer; admins remove only moderators/members', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      const [adm, mod, mem] = [await student(tx, f.schoolId), await student(tx, f.schoolId), await student(tx, f.schoolId)]
      const room = await createRoom(tx, owner, roomInput(), T0)
      for (const [i, who] of [adm, mod, mem].entries()) await joinSpace(tx, who, room.slug, at(i + 1))
      await changeMemberRole(tx, owner, room.slug, adm.userId, { role: 'admin' }, at(5))
      await changeMemberRole(tx, owner, room.slug, mod.userId, { role: 'moderator' }, at(5))
      await expectServiceError(changeMemberRole(tx, adm, room.slug, mem.userId, { role: 'moderator' }), 'FORBIDDEN')
      await expectServiceError(changeMemberRole(tx, owner, room.slug, owner.userId, { role: 'member' }), 'CONFLICT', 'self')
      await expectServiceError(changeMemberRole(tx, owner, room.slug, mem.userId, { role: 'king' }), 'VALIDATION')
      await expectServiceError(listMembers(tx, mod, room.slug), 'FORBIDDEN')
      expect((await getSpaceDetail(tx, mod, room.slug)).permissions).toMatchObject({ moderate: true, manage: false, invite: false })
      expect((await getSpaceDetail(tx, adm, room.slug)).permissions).toMatchObject({ manage: true, invite: true, changeRoles: false, archive: false })
      // admin은 moderator·member만 내보냄
      await expectServiceError(removeMember(tx, adm, room.slug, owner.userId), 'FORBIDDEN')
      await changeMemberRole(tx, owner, room.slug, mem.userId, { role: 'admin' }, at(6))
      await expectServiceError(removeMember(tx, adm, room.slug, mem.userId), 'FORBIDDEN')
      await changeMemberRole(tx, owner, room.slug, mem.userId, { role: 'member' }, at(6))
      const after = await removeMember(tx, adm, room.slug, mem.userId, at(7))
      expect(after.members.map((m) => m.userId)).not.toContain(mem.userId)
      await expectServiceError(getSpaceDetail(tx, mem, room.slug), 'NOT_FOUND') // 내보내진 사람은 소개도 404
      await expectServiceError(joinSpace(tx, mem, room.slug), 'FORBIDDEN', 'removed')
      await expectServiceError(removeMember(tx, adm, room.slug, adm.userId), 'CONFLICT', 'use_leave')
      // 소유권 이전
      const list = await changeMemberRole(tx, owner, room.slug, mod.userId, { role: 'owner' }, at(8))
      const roles = Object.fromEntries(list.members.map((m) => [m.userId, m.role])) as Record<string, SpaceRole>
      expect(roles[mod.userId]).toBe('owner')
      expect(roles[owner.userId]).toBe('admin')
      expect(list.members.filter((m) => m.role === 'owner')).toHaveLength(1)
      // 멤버 목록에 이메일 없음
      expect(JSON.stringify(list)).not.toContain('@example.test')
    })
  })

  it('boards: room owner/admin add up to 10, notice is always moderator-write, official boards are operator-managed', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      const member = await student(tx, f.schoolId)
      const room = await createRoom(tx, owner, roomInput(), T0)
      await joinSpace(tx, member, room.slug, at(1))
      await expectServiceError(createBoard(tx, member, room.slug, { kind: 'free', title: '잡담' }), 'FORBIDDEN')
      expect((await expectServiceError(createBoard(tx, owner, room.slug, { kind: 'freshmen', title: '새내기' }), 'VALIDATION')).fields).toEqual({ kind: 'not_allowed' })
      const noticeBoard = await createBoard(tx, owner, room.slug, { kind: 'notice', title: '공지', writeRole: 'member' }, at(2))
      expect(noticeBoard).toMatchObject({ kind: 'notice', writeRole: 'moderator', canWrite: true })
      expect((await listBoards(tx, member, room.slug)).find((b) => b.id === noticeBoard.id)?.canWrite).toBe(false)
      expect((await updateBoard(tx, owner, noticeBoard.id, { writeRole: 'member' }, at(3))).writeRole).toBe('moderator')
      await expectServiceError(createBoard(tx, owner, room.slug, { kind: 'free', title: '공지' }), 'CONFLICT', 'title_taken')
      for (let i = 0; i < 8; i++) await createBoard(tx, owner, room.slug, { kind: 'free', title: `게시판${i}` }, at(4))
      await expectServiceError(createBoard(tx, owner, room.slug, { kind: 'free', title: '열한째' }), 'CONFLICT', 'too_many_boards')
      const free = await createBoard(tx, f.op, (await createOfficialPage(tx, f.op, { schoolId: f.schoolId }, T0)).slug, { kind: 'free', title: '잡담 2' }, at(5))
      expect(free.kind).toBe('free')
      await expectServiceError(updateBoard(tx, member, free.id, { title: 'x' }), 'FORBIDDEN')
      await expectServiceError(updateBoard(tx, f.op, crypto.randomUUID(), { title: 'x' }), 'NOT_FOUND')
    })
  })

  it('aggregates official page requests per school/department; only operators see counts; threshold notifies once', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const unverified = { userId: (await createUser(tx)).id }
      await expectServiceError(requestOfficialPage(tx, unverified, { schoolId: f.schoolId }), 'FORBIDDEN', 'affiliation_required')
      const outsider = await student(tx, f.otherSchoolId)
      await expectServiceError(requestOfficialPage(tx, outsider, { schoolId: f.schoolId }), 'FORBIDDEN', 'affiliation_required')
      const people = []
      for (let i = 0; i < OFFICIAL_REQUEST_THRESHOLD - 1; i++) people.push(await student(tx, f.schoolId))
      for (const p of people) {
        const r = await requestOfficialPage(tx, p, { schoolId: f.schoolId }, at(1))
        expect(r.created).toBe(true)
        expect(Object.keys(r.request).sort()).toEqual(['createdAt', 'departmentLabel', 'id', 'school'])
      }
      expect((await requestOfficialPage(tx, people[0]!, { schoolId: f.schoolId }, at(2))).created).toBe(false) // 한 사람 한 번
      await expectServiceError(listOfficialRequestGroups(tx, people[0]!), 'FORBIDDEN', 'operator_only')
      const threshold = () =>
        tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.official_request.threshold'), eq(auditEvents.targetId, f.schoolId)))
      let group = (await listOfficialRequestGroups(tx, f.op)).find((g) => g.school.id === f.schoolId && g.departmentKey === '')
      expect(group).toMatchObject({ requesters: OFFICIAL_REQUEST_THRESHOLD - 1, thresholdReached: false, studentCouncil: false, existingSpaceSlug: null })
      expect(await threshold()).toHaveLength(0)
      // 10번째 요청자 → 기준 도달 알림(운영자만, 요청자 id 없음)
      const tenth = await student(tx, f.schoolId)
      await requestOfficialPage(tx, tenth, { schoolId: f.schoolId }, at(3))
      group = (await listOfficialRequestGroups(tx, f.op)).find((g) => g.school.id === f.schoolId && g.departmentKey === '')
      expect(group).toMatchObject({ requesters: OFFICIAL_REQUEST_THRESHOLD, thresholdReached: true })
      expect(await threshold()).toHaveLength(1)
      expect((await threshold())[0]!.metadata).toEqual({ department: false, requesters: OFFICIAL_REQUEST_THRESHOLD, studentCouncil: false })
      await requestOfficialPage(tx, await student(tx, f.schoolId), { schoolId: f.schoolId }, at(4))
      expect(await threshold()).toHaveLength(1) // 기준을 넘은 뒤에는 다시 알리지 않음
      // 인증이 해제된 요청자는 세지 않음(지금 active인 인증 기준)
      await tx
        .update(institutionAffiliations)
        .set({ status: 'revoked', revokedAt: at(5), revokedReason: 'user_removed', emailHash: null })
        .where(inArray(institutionAffiliations.userId, [tenth.userId, people[0]!.userId]))
      group = (await listOfficialRequestGroups(tx, f.op)).find((g) => g.school.id === f.schoolId && g.departmentKey === '')
      expect(group).toMatchObject({ requesters: OFFICIAL_REQUEST_THRESHOLD - 1, thresholdReached: false })

      // 학과 페이지 요청: 학생회 표시로 바로 기준 도달
      const council = await student(tx, f.schoolId)
      const deptReq = await requestOfficialPage(tx, council, { schoolId: f.schoolId, departmentLabel: '전자공학과' }, at(6))
      expect((await listOfficialRequestGroups(tx, f.op)).find((g) => g.departmentLabel === '전자공학과')).toMatchObject({ requesters: 1, thresholdReached: false })
      await expectServiceError(markStudentCouncilRequest(tx, council, deptReq.request.id), 'FORBIDDEN', 'operator_only')
      await markStudentCouncilRequest(tx, f.op, deptReq.request.id)
      expect((await listOfficialRequestGroups(tx, f.op)).find((g) => g.departmentLabel === '전자공학과')).toMatchObject({ studentCouncil: true, thresholdReached: true })
      const notices = await threshold()
      expect(notices).toHaveLength(2)
      expect(notices.map((n) => n.metadata)).toContainEqual({ department: true, requesters: 1, studentCouncil: true })

      // 개설 뒤 요청은 409(slug 안내), 묶음에 열린 페이지 표시
      const page = await createOfficialPage(tx, f.op, { schoolId: f.schoolId }, at(7))
      const e = await expectServiceError(requestOfficialPage(tx, await student(tx, f.schoolId), { schoolId: f.schoolId }), 'CONFLICT', 'official_exists')
      expect(e.details).toEqual({ slug: page.slug })
      expect((await listOfficialRequestGroups(tx, f.op)).find((g) => g.school.id === f.schoolId && g.departmentKey === '')?.existingSpaceSlug).toBe(page.slug)
    })
  })

  it('reports on community spaces reuse the T-15 queue; operators restrict/lift/archive without reading content', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      const member = await student(tx, f.schoolId)
      const stranger = await student(tx, f.schoolId)
      const room = await createRoom(tx, owner, roomInput({ name: '사칭 의심 방', joinPolicy: 'invite', discovery: 'unlisted' }), T0)
      const { token: t } = await createSpaceInvitation(tx, owner, room.slug, at(1))
      await acceptSpaceInvitation(tx, member, { token: t }, at(1))
      // 읽을 수 없는 사람은 신고 대상 자체가 404
      await expectServiceError(createReport(tx, stranger, { targetType: 'community_space', targetRef: { spaceSlug: room.slug }, reason: 'harassment' }, at(2)), 'NOT_FOUND')
      await expectServiceError(createReport(tx, member, { targetType: 'community_space', targetRef: { spaceSlug: 'bad' }, reason: 'harassment' }, at(2)), 'VALIDATION')
      const receipt = await createReport(tx, member, { targetType: 'community_space', targetRef: { spaceSlug: room.slug }, reason: 'harassment', details: '학생회 사칭' }, at(2))
      expect(receipt).toMatchObject({ created: true, status: 'received' })
      const detail = await getReportDetail(tx, f.op, receipt.id, at(3))
      expect(detail).toMatchObject({ targetType: 'community_space', targetLabel: '커뮤니티 공간 · 사칭 의심 방', allowedActions: ['none', 'restrict_space'], publicPath: null })
      expect(detail.content).toMatchObject({ kind: 'community_space', space: { slug: room.slug, status: 'active', memberCount: 2 } })
      expect(JSON.stringify(detail.content)).not.toContain('boards')
      await expectServiceError(resolveReport(tx, f.op, receipt.id, { action: 'hide_note', note: 'x' }), 'VALIDATION')
      await resolveReport(tx, f.op, receipt.id, { action: 'restrict_space', note: '학생회 사칭 확인', publicReason: '사칭', notifyOwner: true }, at(4))
      const restricted = await getSpaceDetail(tx, member, room.slug)
      expect(restricted).toMatchObject({ status: 'restricted', permissions: { manage: false, invite: false } })
      expect(restricted.boards.every((b) => !b.canWrite)).toBe(true)
      await expectServiceError(createSpaceInvitation(tx, owner, room.slug), 'CONFLICT', 'space_not_active')
      const spaceId = (await listSpacesForOperator(tx, f.op, { status: 'restricted' })).find((s) => s.slug === room.slug)!.id
      await expectServiceError(restrictSpace(tx, f.op, spaceId, { note: 'again' }), 'CONFLICT', 'target_not_public')
      await expectServiceError(liftSpaceRestriction(tx, member, spaceId, { note: 'x' }), 'FORBIDDEN', 'operator_only')
      expect(await liftSpaceRestriction(tx, f.op, spaceId, { note: '소명 확인' }, at(5))).toMatchObject({ status: 'active' })
      await expectServiceError(liftSpaceRestriction(tx, f.op, spaceId, { note: 'x' }), 'CONFLICT', 'not_restricted')
      expect(await restrictSpace(tx, f.op, spaceId, { note: '직접 제한' }, at(6))).toMatchObject({ status: 'restricted' })
      expect(await archiveSpaceByOperator(tx, f.op, spaceId, { note: '정리' }, at(7))).toMatchObject({ status: 'archived' })
      await expectServiceError(archiveSpaceByOperator(tx, f.op, spaceId, { note: '정리' }), 'CONFLICT', 'already_archived')

      // 운영자 메모는 운영 조치 행에만 남고, 감사 기록에는 id·종류만 남습니다(ADR 0015).
      const actions = await tx.select().from(moderationActions).where(eq(moderationActions.communitySpaceId, spaceId))
      expect(actions.map((a) => [a.kind, a.internalNote]).sort()).toEqual(
        expect.arrayContaining([
          ['archive_space', '정리'],
          ['restrict_space', '직접 제한'],
        ]),
      )
      const audits = await tx
        .select({ action: auditEvents.action, metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(and(eq(auditEvents.targetId, spaceId), inArray(auditEvents.action, ['community.space_restrict', 'community.space_lift', 'community.space_archive'])))
      expect(audits.length).toBeGreaterThanOrEqual(3)
      for (const note of ['소명 확인', '직접 제한', '정리']) expect(JSON.stringify(audits)).not.toContain(note)
    })
  })

  it('study rooms only come from the guarded internal service (invite-only, unlisted, display by default)', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      await expectServiceError(createStudyRoomInternal(tx, { ownerId: (await createUser(tx)).id, name: '스터디', schoolId: null }), 'FORBIDDEN', 'affiliation_required')
      const row = await createStudyRoomInternal(tx, { ownerId: owner.userId, name: '자료구조 스터디', schoolId: f.schoolId }, T0)
      expect(row).toMatchObject({ kind: 'study_room', joinPolicy: 'invite', discovery: 'unlisted', currentNameMode: 'display' })
      const detail = await getSpaceDetail(tx, owner, row.slug)
      expect(detail).toMatchObject({ kind: 'study_room', official: false, myMembership: { role: 'owner' } })
      await expectServiceError(joinSpace(tx, await student(tx, f.schoolId), row.slug), 'FORBIDDEN', 'invite_only')
    })
  })

  it('never exposes community data through public search or search_documents', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await student(tx, f.schoolId)
      const sentinel = `센티넬${token()}`
      const [before] = await tx.select({ n: sql<number>`count(*)::int` }).from(searchDocuments)
      const room = await createRoom(tx, owner, roomInput({ name: `${sentinel} 방`, description: `${sentinel} 소개` }), T0)
      await createBoard(tx, owner, room.slug, { kind: 'free', title: sentinel.slice(0, 20) }, at(1))
      await createOfficialPage(tx, f.op, { schoolId: f.schoolId, name: `${sentinel} 공식`, description: sentinel }, at(1))
      const { token: t } = await createSpaceInvitation(tx, owner, room.slug, at(2))
      await acceptSpaceInvitation(tx, await student(tx, f.schoolId), { token: t }, at(2))
      const [after] = await tx.select({ n: sql<number>`count(*)::int` }).from(searchDocuments)
      expect(after!.n).toBe(before!.n)
      for (const type of [undefined, 'case', 'stuck', 'note']) {
        const result = await searchPublic(tx, { q: sentinel, ...(type && { type }) }, at(3))
        expect(result.results).toEqual([])
        expect(JSON.stringify(result.results)).not.toContain(sentinel)
      }
    })
  })
})

// ── 소스 경계(DB 없이) ───────────────────────────────────────────────────

const SERVER = resolve(__dirname, '../server')
const listTs = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listTs(path) : path.endsWith('.ts') ? [path] : []
  })
const COMMUNITY_TABLES = /\b(communitySpaces|spaceMemberships|boards|spaceInvitations|officialPageRequests|community_spaces|space_memberships|space_invitations|official_page_requests)\b/

describe('community module boundary (source)', () => {
  it('no /api/v1/public route and no public read module imports the community module or its tables', () => {
    const publicFiles = [
      ...listTs(join(SERVER, 'api/v1/public')),
      ...['publication/public-read.ts', 'publication/public-http.ts', 'course-hub/hub.ts', 'course-hub/search.ts', 'course-hub/public-http.ts', 'course-hub/public-scope.ts', 'portfolio/public-profile.ts', 'portfolio/public-http.ts', 'portfolio/view.ts', 'portfolio/release-scope.ts'].map((p) =>
        join(SERVER, 'modules', p),
      ),
    ]
    expect(publicFiles.length).toBeGreaterThan(10)
    for (const file of publicFiles) {
      const text = readFileSync(file, 'utf8')
      expect(text, relative(SERVER, file)).not.toMatch(/modules\/community|\.\.\/community\//)
      expect(text, relative(SERVER, file)).not.toMatch(COMMUNITY_TABLES)
    }
  })

  it('community routes live only under /api/v1/community, /api/v1/operator/community and the operator community metrics (C-10)', () => {
    const routes = listTs(join(SERVER, 'api')).filter((f) => readFileSync(f, 'utf8').includes('modules/community/'))
    expect(routes.length).toBeGreaterThan(20)
    // C-10(ADR 0027): /api/v1/operator/metrics/community/*는 집계 모듈(ops-metrics)만 import합니다(C-05 경계 검사의 문서화된 예외).
    for (const f of routes) expect(relative(SERVER, f)).toMatch(/^api\/v1\/(community|operator\/community|operator\/metrics\/community)\//)
  })

  it('the worker search indexer never reads community tables', () => {
    const worker = resolve(__dirname, '../../worker/src')
    // 예외: 탈퇴 정리(purge)와 이름 표시 방식 변경 적용(C-03, ops/name-modes.ts·그 명령). 둘 다 검색 색인과 무관합니다.
    const exempt = ['ops/purge.ts', 'ops/name-modes.ts', 'apply-name-modes.ts']
    for (const file of listTs(worker).filter((f) => !exempt.some((e) => f.endsWith(e)))) {
      expect(readFileSync(file, 'utf8'), relative(worker, file)).not.toMatch(COMMUNITY_TABLES)
    }
  })
})
