/**
 * I-02 기관 페이지·기수 방·기관 운영진 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다. 라우트 검사는 DB 없이 돕니다.
 * - 플래그(institutions)가 꺼져 있으면 새 서비스·기관 페이지·기수 방 모두 404, 대학 공식 페이지는 그대로.
 * - 운영진 지정·해제는 운영자만, 감사는 id만.
 * - 권한 표: 자기 기관 페이지에서 모더레이터 범위(가리기·되돌리기·공지·게시판·설정)만, 다른 기관 404, 작성자 확인 403, 멤버 목록 없음,
 *   보관·가입 관리·역할 없음, 자기 기관 초대 코드만 발급·철회, 수료증 확인 403.
 * - 기수 방: 그 기수 인증(수단 무관)만 가입·읽기, 인증이 끝나면 404, 기수마다 하나, 운영진은 멤버 목록·방별 프로필·명부를 못 봄.
 * - 기관 집계: 5 미만 null, 합계·사람 목록 없음.
 * - I-01 남은 문제: 대학이 아닌 기관 인증으로 사용자 방 만들기·기관 페이지 개설 요청(플래그 켜짐만, 학과 없음).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, auditEvents, eq, institutionStaff, operators, type DbExecutor } from '@peerchive/db'
import { removeAffiliation } from '../server/modules/affiliation/affiliations'
import { createSchool } from '../server/modules/catalog/catalog'
import { createCohortRoom, getInstitutionOverview, getInstitutionStats } from '../server/modules/community/institution-pages'
import { listMembers, joinSpace } from '../server/modules/community/memberships'
import { listDirectory } from '../server/modules/community/member-directory'
import { lookupAuthor, spaceHideItem, spaceUnhideItem, getSpaceModeration } from '../server/modules/community/moderation'
import { createOfficialPage, requestOfficialPage } from '../server/modules/community/official'
import { createPost, getPost } from '../server/modules/community/posts'
import { listRoomProfiles } from '../server/modules/community/room-profiles'
import { archiveSpace, createBoard, createRoom, discoverSpaces, getSpaceDetail, listMySpaces, updateSpace } from '../server/modules/community/spaces'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { listCertificateChecks } from '../server/modules/institutions/certificates'
import {
  createInstitution,
  issueInviteCode,
  issueStaffInviteCode,
  listStaffInviteCodes,
  redeemInviteCode,
  revokeStaffInviteCode,
} from '../server/modules/institutions/institutions'
import { grantInstitutionStaff, listInstitutionStaff, listMyStaffInstitutions, revokeInstitutionStaff } from '../server/modules/institutions/staff'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-03T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const ON = { PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'on', PEERCHIVE_FEATURE_P2_ALUMNI: 'on' }

async function operator(db: DbExecutor) {
  const user = await createUser(db)
  await db.insert(operators).values({ userId: user.id })
  return { userId: user.id }
}

async function bootcamp(db: DbExecutor, op: { userId: string }) {
  return createInstitution(db, op, { name: `피어캠프${token()}`, kind: 'bootcamp' }, T0)
}

/** 초대 코드로 그 기관(·기수)에 active 인증된 사용자. */
async function verified(db: DbExecutor, op: { userId: string }, institutionId: string, cohortLabel: string | null, standing: 'student' | 'alumni' = 'alumni') {
  const user = await createUser(db)
  const issued = await issueInviteCode(db, op, institutionId, { maxUses: 1, ...(cohortLabel && { cohortLabel }) }, T0)
  const dto = await redeemInviteCode(db, { userId: user.id }, { code: issued.code, standing }, { ip: crypto.randomUUID(), now: at(1) })
  return { userId: user.id, affiliationId: dto.id }
}

/** 운영자 + 기관 둘(A·B)과 각 기관 페이지 + A 운영진(인증 없음) + A 1기 멤버. */
async function world(db: DbExecutor) {
  const op = await operator(db)
  const A = await bootcamp(db, op)
  const B = await bootcamp(db, op)
  const pageA = await createOfficialPage(db, op, { schoolId: A.id }, T0)
  const pageB = await createOfficialPage(db, op, { schoolId: B.id }, T0)
  const staff = { userId: (await createUser(db)).id }
  await grantInstitutionStaff(db, op, A.id, { userId: staff.userId }, T0)
  const member = await verified(db, op, A.id, '1기')
  const memberB = await verified(db, op, B.id, '1기')
  return { op, A, B, pageA, pageB, staff, member, memberB }
}

const boardOf = (detail: { boards: Array<{ id: string; kind: string }> }, kind: string) => detail.boards.find((b) => b.kind === kind)!.id

describe.skipIf(!databaseUrl)('I-02 institution pages, cohort rooms and institution staff (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('flag off: every new service, institution pages and cohort rooms are 404; university official pages are unchanged', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await createCohortRoom(tx, w.staff, w.A.id, { cohortLabel: '1기' }, at(2))
      const issued = await issueStaffInviteCode(tx, w.staff, w.A.id, { maxUses: 3 }, at(2))
      const uni = await createSchool(tx, { userId: (await createUser(tx)).id }, { name: `피어대학교${token()}` })
      const student = { userId: (await createUser(tx)).id }
      await verifiedAffiliation(tx, student.userId, uni.id)
      setFeatureEnvForTesting({})
      const s = w.staff
      await expectServiceError(listMyStaffInstitutions(tx, s), 'NOT_FOUND')
      await expectServiceError(listInstitutionStaff(tx, w.op, w.A.id), 'NOT_FOUND')
      await expectServiceError(grantInstitutionStaff(tx, w.op, w.A.id, { userId: w.member.userId }), 'NOT_FOUND')
      await expectServiceError(revokeInstitutionStaff(tx, w.op, w.A.id, s.userId), 'NOT_FOUND')
      await expectServiceError(issueStaffInviteCode(tx, s, w.A.id, { maxUses: 1 }), 'NOT_FOUND')
      await expectServiceError(listStaffInviteCodes(tx, s, w.A.id), 'NOT_FOUND')
      await expectServiceError(revokeStaffInviteCode(tx, s, issued.id), 'NOT_FOUND')
      await expectServiceError(getInstitutionOverview(tx, s, w.A.id), 'NOT_FOUND')
      await expectServiceError(createCohortRoom(tx, s, w.A.id, { cohortLabel: '2기' }), 'NOT_FOUND')
      await expectServiceError(getInstitutionStats(tx, s, w.A.id), 'NOT_FOUND')
      // 기관 페이지·기수 방은 인증 멤버에게도, 운영자에게도 없는 공간처럼 404이고 목록에도 없습니다.
      await expectServiceError(getSpaceDetail(tx, w.member, w.pageA.slug), 'NOT_FOUND')
      await expectServiceError(getSpaceDetail(tx, w.op, w.pageA.slug), 'NOT_FOUND')
      await expectServiceError(getSpaceDetail(tx, w.member, room.slug), 'NOT_FOUND')
      expect((await listMySpaces(tx, w.member)).items.map((i) => i.slug)).not.toContain(w.pageA.slug)
      expect((await discoverSpaces(tx, w.member, {})).map((i) => i.slug)).toEqual([])
      // 기관 페이지 요청·개설도 404
      await expectServiceError(requestOfficialPage(tx, w.member, { schoolId: w.A.id }), 'NOT_FOUND')
      setFeatureEnvForTesting(ON)
      const D = await bootcamp(tx, w.op)
      setFeatureEnvForTesting({})
      await expectServiceError(createOfficialPage(tx, w.op, { schoolId: D.id }), 'NOT_FOUND')
      // 대학 공식 페이지는 플래그와 무관(기존 C-02 그대로, 새내기 게시판 포함)
      const uniPage = await createOfficialPage(tx, w.op, { schoolId: uni.id }, at(3))
      expect(uniPage.boards.map((b) => b.kind)).toContain('freshmen')
      expect(uniPage.institutionSpace).toBeNull()
      expect((await getSpaceDetail(tx, student, uniPage.slug)).access).toBe('member')
    })
  })

  it('operators grant and revoke staff (non-university only), audited with ids only; others are 403', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const A = await bootcamp(tx, op)
      const user = { userId: (await createUser(tx)).id }
      const other = { userId: (await createUser(tx)).id }
      await expectServiceError(grantInstitutionStaff(tx, user, A.id, { userId: other.userId }), 'FORBIDDEN', 'operator_only')
      await expectServiceError(listInstitutionStaff(tx, user, A.id), 'FORBIDDEN', 'operator_only')
      const uni = await createSchool(tx, { userId: user.userId }, { name: `피어대${token()}` })
      expect((await expectServiceError(grantInstitutionStaff(tx, op, uni.id, { userId: other.userId }), 'VALIDATION')).fields).toEqual({ institutionId: 'not_supported' })
      expect((await expectServiceError(grantInstitutionStaff(tx, op, A.id, { userId: crypto.randomUUID() }), 'VALIDATION')).fields).toEqual({ userId: 'not_found' })
      const list = await grantInstitutionStaff(tx, op, A.id, { userId: other.userId }, T0)
      expect(list.map((s) => s.userId)).toEqual([other.userId])
      await expectServiceError(grantInstitutionStaff(tx, op, A.id, { userId: other.userId }, T0), 'CONFLICT', 'already_staff')
      expect(await listMyStaffInstitutions(tx, other)).toEqual([{ id: A.id, name: A.name, kind: 'bootcamp' }])
      expect(await listMyStaffInstitutions(tx, user)).toEqual([])
      await revokeInstitutionStaff(tx, op, A.id, other.userId, at(1))
      await expectServiceError(revokeInstitutionStaff(tx, op, A.id, other.userId, at(1)), 'NOT_FOUND')
      expect(await listMyStaffInstitutions(tx, other)).toEqual([])
      // 다시 지정할 수 있고(해제 행은 남음), 감사는 id만.
      await grantInstitutionStaff(tx, op, A.id, { userId: other.userId }, at(2))
      const rows = await tx.select().from(institutionStaff).where(eq(institutionStaff.userId, other.userId))
      expect(rows).toHaveLength(2)
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetType, 'institution_staff')))
      const mine = audits.filter((a) => rows.some((r) => r.id === a.targetId))
      expect(mine.map((a) => a.action).sort()).toEqual(['institution_staff.grant', 'institution_staff.grant', 'institution_staff.revoke'])
      for (const a of mine) {
        expect(a.actorId).toBe(op.userId)
        expect(Object.keys(a.metadata as object).sort()).toEqual(['schoolId', 'userId'])
        expect(a.metadata).toEqual({ schoolId: A.id, userId: other.userId })
      }
    })
  })

  it('permission matrix on the institution page: moderator-level actions on their own page only, no author lookup, no member list', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const s = w.staff
      // 기관 페이지: 새내기 없이 수료생 게시판
      expect(w.pageA.institutionSpace).toBe('page')
      expect(w.pageA.boards.map((b) => [b.kind, b.title])).toEqual([
        ['free', '자유'],
        ['alumni', '수료생'],
        ['question', '질문'],
        ['info', '정보'],
        ['recruiting', '모집'],
        ['notice', '공지'],
      ])
      const memberView = await getSpaceDetail(tx, w.member, w.pageA.slug)
      const post = await createPost(tx, w.member, boardOf(memberView, 'free'), { title: '익명 글', body: '본문' }, at(2))
      const postB = await createPost(tx, w.memberB, boardOf(await getSpaceDetail(tx, w.memberB, w.pageB.slug), 'free'), { title: 'B 글', body: '본문' }, at(2))

      const detail = await getSpaceDetail(tx, s, w.pageA.slug, at(3))
      expect(detail.access).toBe('member')
      expect(detail.permissions).toEqual({
        manage: true,
        manageBoards: true,
        reviewRequests: false,
        removeMembers: false,
        invite: false,
        changeRoles: false,
        archive: false,
        moderate: true,
        changeNameMode: false,
      })
      // 공지는 쓰고(모더레이터 범위), 일반 게시판은 그 기관 인증이 없으므로 못 씀.
      expect(detail.boards.find((b) => b.kind === 'notice')!.canWrite).toBe(true)
      expect(detail.boards.find((b) => b.kind === 'free')!.canWrite).toBe(false)
      await createPost(tx, s, boardOf(detail, 'notice'), { title: '공지', body: '안내' }, at(3))
      await expectServiceError(createPost(tx, s, boardOf(detail, 'free'), { title: '자유', body: '본문' }, at(3)), 'FORBIDDEN', 'write_not_allowed')
      // 가리기·되돌리기·운영 화면
      expect((await spaceHideItem(tx, s, 'post', post.id, { publicReason: '확인 중' }, at(4))).status).toBe('hidden')
      expect((await spaceUnhideItem(tx, s, 'post', post.id, {}, at(5))).status).toBe('published')
      const moderation = await getSpaceModeration(tx, s, w.pageA.slug, at(5))
      expect(JSON.stringify(moderation)).not.toContain(w.member.userId)
      // 게시판·설정은 되고, 보관은 안 됨
      await createBoard(tx, s, w.pageA.slug, { kind: 'info', title: '취업 정보' }, at(5))
      expect((await updateSpace(tx, s, w.pageA.slug, { description: '기관 안내' }, at(5))).description).toBe('기관 안내')
      await expectServiceError(archiveSpace(tx, s, w.pageA.slug, at(5)), 'FORBIDDEN')
      // 멤버 목록 없음
      await expectServiceError(listMembers(tx, s, w.pageA.slug), 'CONFLICT', 'no_member_list')
      // 작성자를 알 수 없음: 응답은 일반 멤버와 같은 익명 표시, 작성자 확인은 운영자만(403)
      const seen = await getPost(tx, s, post.id, at(6))
      expect(seen.author).toMatchObject({ kind: 'anonymous', mine: false })
      expect(JSON.stringify(seen)).not.toContain(w.member.userId)
      const peer = await verified(tx, w.op, w.A.id, null)
      expect(seen.author).toEqual((await getPost(tx, peer, post.id, at(6))).author)
      await expectServiceError(lookupAuthor(tx, s, { targetType: 'post', targetId: post.id, reason: '누구인지' }, at(6)), 'FORBIDDEN', 'operator_only')
      // 다른 기관 페이지에는 아무 권한이 없음(존재도 404)
      await expectServiceError(getSpaceDetail(tx, s, w.pageB.slug), 'NOT_FOUND')
      await expectServiceError(spaceHideItem(tx, s, 'post', postB.id, { publicReason: 'x' }, at(6)), 'NOT_FOUND')
      await expectServiceError(createBoard(tx, s, w.pageB.slug, { kind: 'info', title: '정보2' }), 'NOT_FOUND')
      // 수료증 확인은 운영자만
      await expectServiceError(listCertificateChecks(tx, s, {}), 'FORBIDDEN', 'operator_only')
      // 해제되면 다음 요청부터 404
      await revokeInstitutionStaff(tx, w.op, w.A.id, s.userId, at(7))
      await expectServiceError(getSpaceDetail(tx, s, w.pageA.slug), 'NOT_FOUND')
      await expectServiceError(spaceHideItem(tx, s, 'post', post.id, { publicReason: 'x' }, at(8)), 'NOT_FOUND')
    })
  })

  it('staff issue and revoke invite codes for their own institution only; codes of other institutions are 404', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const s = w.staff
      const mine = await issueStaffInviteCode(tx, s, w.A.id, { maxUses: 3, cohortLabel: '3기' }, at(1))
      expect(mine.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
      expect(mine.cohortLabel).toBe('3기')
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'invite_code.issue'), eq(auditEvents.targetId, mine.id)))
      expect(audit!.metadata).toEqual({ schoolId: w.A.id, cohort: true, maxUses: 3, byStaff: true })
      expect((await listStaffInviteCodes(tx, s, w.A.id)).map((c) => c.id)).toContain(mine.id)
      expect(JSON.stringify(await listStaffInviteCodes(tx, s, w.A.id))).not.toContain(mine.code)
      const user = { userId: (await createUser(tx)).id }
      await redeemInviteCode(tx, user, { code: mine.code, standing: 'student' }, { ip: 'x', now: at(2) })
      // 다른 기관: 발급·목록 403, 철회 404
      await expectServiceError(issueStaffInviteCode(tx, s, w.B.id, { maxUses: 1 }), 'FORBIDDEN', 'institution_staff_only')
      await expectServiceError(listStaffInviteCodes(tx, s, w.B.id), 'FORBIDDEN', 'institution_staff_only')
      const theirs = await issueInviteCode(tx, w.op, w.B.id, { maxUses: 1 }, at(1))
      await expectServiceError(revokeStaffInviteCode(tx, s, theirs.id, at(3)), 'NOT_FOUND')
      await expectServiceError(revokeStaffInviteCode(tx, s, crypto.randomUUID(), at(3)), 'NOT_FOUND')
      // 일반 사용자(그 기관 인증 멤버여도)는 403
      await expectServiceError(issueStaffInviteCode(tx, w.member, w.A.id, { maxUses: 1 }), 'FORBIDDEN', 'institution_staff_only')
      const revoked = await revokeStaffInviteCode(tx, s, mine.id, at(3))
      expect(revoked.revokedAt).not.toBeNull()
      // 운영자는 같은 경로로 어느 기관이든
      expect((await issueStaffInviteCode(tx, w.op, w.B.id, { maxUses: 1 }, at(4))).institution.id).toBe(w.B.id)
    })
  })

  it('cohort rooms: only members verified for that cohort (any method) join and read; staff moderate but see no member list, profiles or directory', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const s = w.staff
      const room = await createCohortRoom(tx, s, w.A.id, { cohortLabel: '1기' }, at(2))
      expect(room).toMatchObject({ kind: 'user_room', template: 'alumni', joinPolicy: 'open', institutionSpace: 'cohort_room', nameMode: 'display', access: 'member' })
      expect(room.name).toBe(`${w.A.name} 1기`)
      expect(room.permissions).toMatchObject({ manage: true, manageBoards: true, moderate: true, reviewRequests: false, removeMembers: false, invite: false, changeRoles: false, archive: false, changeNameMode: false })
      await expectServiceError(createCohortRoom(tx, w.op, w.A.id, { cohortLabel: ' 1 기 ' }, at(3)), 'CONFLICT', 'cohort_room_exists')
      await expectServiceError(createCohortRoom(tx, s, w.B.id, { cohortLabel: '1기' }, at(3)), 'FORBIDDEN', 'institution_staff_only')
      await expectServiceError(createCohortRoom(tx, w.member, w.A.id, { cohortLabel: '1기' }, at(3)), 'FORBIDDEN', 'institution_staff_only')

      // 1기(초대 코드) 멤버는 찾고 들어옴. 기수 승인·수료증으로 인증돼도 같은 기수 id면 같음(수단 무관 — 판정은 cohort_id만 봄).
      expect((await discoverSpaces(tx, w.member, {})).map((r) => r.slug)).toContain(room.slug)
      expect((await joinSpace(tx, w.member, room.slug, at(3))).status).toBe('active')
      // 2기·기수 없는 인증·다른 기관 1기는 소개도 404, 찾기에도 없음
      const second = await verified(tx, w.op, w.A.id, '2기')
      const noCohort = await verified(tx, w.op, w.A.id, null)
      for (const u of [second, noCohort, w.memberB]) {
        await expectServiceError(getSpaceDetail(tx, u, room.slug), 'NOT_FOUND')
        await expectServiceError(joinSpace(tx, u, room.slug, at(4)), 'NOT_FOUND')
        expect((await discoverSpaces(tx, u, {})).map((r) => r.slug)).not.toContain(room.slug)
      }
      // 가입·찾기를 바꿀 수 없음
      expect((await expectServiceError(updateSpace(tx, s, room.slug, { joinPolicy: 'invite' }), 'VALIDATION')).fields).toEqual({ joinPolicy: 'not_editable' })
      // 운영진: 운영 조치는 하지만 멤버 목록·방별 프로필·명부는 못 봄(멤버가 아님)
      const memberDetail = await getSpaceDetail(tx, w.member, room.slug, at(5))
      await insertDisplayPersona(tx, w.member.userId, `camp${token()}`)
      const post = await createPost(tx, w.member, boardOf(memberDetail, 'general'), { title: '기수 글', body: '본문' }, at(5))
      expect((await spaceHideItem(tx, s, 'post', post.id, { publicReason: '확인' }, at(6))).status).toBe('hidden')
      await expectServiceError(listMembers(tx, s, room.slug), 'NOT_FOUND')
      await expectServiceError(listRoomProfiles(tx, s, room.slug, at(6)), 'NOT_FOUND')
      await expectServiceError(listDirectory(tx, s, room.slug, {}, at(6)), 'NOT_FOUND')
      // 표시명 방이라 운영진도 표시명 페르소나로 공지를 씁니다(일반 게시판은 못 씀).
      await insertDisplayPersona(tx, s.userId, '캠프 운영진')
      await createPost(tx, s, boardOf(room, 'notice'), { title: '공지', body: '안내' }, at(6))
      await expectServiceError(createPost(tx, s, boardOf(room, 'general'), { title: 'x', body: 'y' }, at(6)), 'FORBIDDEN', 'write_not_allowed')
      // 운영진 목록: 기관 페이지·기수 방(멤버 수 5 미만은 null)
      const overview = await getInstitutionOverview(tx, s, w.A.id)
      expect(overview).toMatchObject({ asOperator: false, page: { slug: w.pageA.slug }, cohortRooms: [{ slug: room.slug, cohortLabel: '1기', memberCount: null }] })
      expect((await listMySpaces(tx, s)).items.map((i) => i.slug).sort()).toEqual([w.pageA.slug, room.slug].sort())
      // 인증이 끝나면 다음 요청부터 404(멤버십이 남아도)
      await removeAffiliation(tx, w.member, w.member.affiliationId, at(7))
      await expectServiceError(getSpaceDetail(tx, w.member, room.slug), 'NOT_FOUND')
      // 운영진이 아닌 다른 기관 운영진은 이 방을 못 읽음
      const staffB = { userId: (await createUser(tx)).id }
      await grantInstitutionStaff(tx, w.op, w.B.id, { userId: staffB.userId }, at(7))
      await expectServiceError(getSpaceDetail(tx, staffB, room.slug), 'NOT_FOUND')
    })
  })

  it('staff have no powers in user rooms linked to their institution; non-university verification can create user rooms (I-01 decision)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      // 부트캠프 인증만 있는 사람도 학교 무관 방·자기 기관 연결 방을 만들 수 있음(인증 수준이 학교 메일과 같거나 높음, ADR 0044)
      expect((await listMySpaces(tx, w.member)).canCreateRoom).toBe(true)
      const free = await createRoom(tx, w.member, { name: '프론트엔드 스터디', nameMode: 'display' }, at(1))
      const linked = await createRoom(tx, w.member, { name: '캠프 동기 모임', nameMode: 'display', schoolId: w.A.id }, at(1))
      expect(linked.institutionSpace).toBeNull()
      // 다른 기관 연결은 403
      await expectServiceError(createRoom(tx, w.member, { name: '남의 캠프', nameMode: 'display', schoolId: w.B.id }, at(1)), 'FORBIDDEN', 'affiliation_required')
      // 운영진은 사용자 방에 아무 권한이 없음(읽기 404)
      for (const slug of [free.slug, linked.slug]) await expectServiceError(getSpaceDetail(tx, w.staff, slug), 'NOT_FOUND')
      // 기관 페이지 개설 요청: 인증 멤버는 낼 수 있고(학교 페이지만), 학과는 422
      await expectServiceError(requestOfficialPage(tx, w.member, { schoolId: w.B.id }), 'FORBIDDEN', 'affiliation_required')
      const op = w.op
      const C = await bootcamp(tx, op)
      const cMember = await verified(tx, op, C.id, null)
      expect((await requestOfficialPage(tx, cMember, { schoolId: C.id }, at(2))).created).toBe(true)
      expect((await expectServiceError(requestOfficialPage(tx, cMember, { schoolId: C.id, departmentLabel: '프론트엔드' }), 'VALIDATION')).fields).toEqual({ departmentLabel: 'not_supported' })
      expect((await expectServiceError(createOfficialPage(tx, op, { schoolId: C.id, departmentLabel: '백엔드' }), 'VALIDATION')).fields).toEqual({ departmentLabel: 'not_supported' })
      await expectServiceError(requestOfficialPage(tx, w.member, { schoolId: w.A.id }), 'CONFLICT', 'official_exists')
    })
  })

  it('institution stats are aggregates only: every count below 5 is null, no totals and no people', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const s = w.staff
      const small = await getInstitutionStats(tx, s, w.A.id, at(10))
      expect(small).toMatchObject({ minGroup: 5, verifiedMembers: { student: null, alumni: null }, page: { posts30d: null, comments30d: null }, cohortRooms: 0 })
      const alumni = [w.member]
      for (let i = 0; i < 4; i++) alumni.push(await verified(tx, w.op, w.A.id, '1기', 'alumni'))
      const freeBoard = boardOf(await getSpaceDetail(tx, w.member, w.pageA.slug), 'free')
      for (let i = 0; i < 5; i++) await createPost(tx, alumni[i]!, freeBoard, { title: `글${i}`, body: '본문' }, at(2 + i))
      await createCohortRoom(tx, s, w.A.id, { cohortLabel: '1기' }, at(8))
      const stats = await getInstitutionStats(tx, s, w.A.id, at(10))
      expect(stats.verifiedMembers).toEqual({ student: null, alumni: 5 })
      expect(stats.page).toEqual({ posts30d: 5, comments30d: null })
      expect(stats.cohortRooms).toBe(1)
      expect(Object.keys(stats).sort()).toEqual(['cohortRooms', 'generatedAt', 'institution', 'minGroup', 'page', 'verifiedMembers'])
      const json = JSON.stringify(stats)
      for (const u of alumni) expect(json).not.toContain(u.userId)
      // 30일이 지난 글은 세지 않음
      expect((await getInstitutionStats(tx, s, w.A.id, new Date(at(10).getTime() + 31 * 24 * 3600 * 1000))).page).toEqual({ posts30d: null, comments30d: null })
      // 다른 기관·일반 멤버는 403
      await expectServiceError(getInstitutionStats(tx, s, w.B.id), 'FORBIDDEN', 'institution_staff_only')
      await expectServiceError(getInstitutionStats(tx, w.member, w.A.id), 'FORBIDDEN', 'institution_staff_only')
      expect((await getInstitutionStats(tx, w.op, w.B.id, at(10))).verifiedMembers).toEqual({ student: null, alumni: null })
    })
  })
})

// ── 라우트 검사(DB 없이): 기관 단위 사용자 조회 경로가 없음 ─────────────────

describe('I-02 no institution-level user lookup routes (source)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const apiRoot = join(here, '..', 'server', 'api')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : [p]
    })
  const routes = walk(apiRoot).map((p) => relative(apiRoot, p))

  it('the institution routes are exactly the staff/operator tools (no member, profile, project, affiliation or export route)', () => {
    const institutionRoutes = routes.filter((r) => /institution|invite-code/i.test(r)).sort()
    expect(institutionRoutes).toEqual([
      'v1/community/institutions/[id]/cohort-rooms.post.ts',
      'v1/community/institutions/[id]/index.get.ts',
      'v1/community/institutions/[id]/stats.get.ts',
      'v1/institutions/[id]/invite-codes/index.get.ts',
      'v1/institutions/[id]/invite-codes/index.post.ts',
      'v1/institutions/index.get.ts',
      'v1/invite-codes/[id]/revoke.post.ts',
      'v1/me/affiliations/invite-code.post.ts',
      'v1/me/institution-staff.get.ts',
      'v1/operator/institutions/[id]/invite-codes/index.get.ts',
      'v1/operator/institutions/[id]/invite-codes/index.post.ts',
      'v1/operator/institutions/[id]/staff/[userId].delete.ts',
      'v1/operator/institutions/[id]/staff/index.get.ts',
      'v1/operator/institutions/[id]/staff/index.post.ts',
      'v1/operator/institutions/index.post.ts',
      'v1/operator/invite-codes/[id]/revoke.post.ts',
    ])
    // 운영진이 쓰는 경로(운영자 경로 밖)에는 사람·프로필·과제·소속·내보내기 경로가 없습니다.
    for (const r of institutionRoutes.filter((x) => !x.startsWith('v1/operator/') && !x.startsWith('v1/me/'))) {
      expect(r).not.toMatch(/member|user|profile|project|affiliation|follow|director|export|csv|download|search|people|roster/i)
    }
  })

  it('the staff-facing modules never import people tables (users only for the operator staff list and status check)', () => {
    const modules = join(here, '..', 'server', 'modules')
    const dbImports = (file: string) => {
      const text = readFileSync(join(modules, file), 'utf8')
      const m = text.match(/import \{([^}]*)\} from '@peerchive\/db'/)
      return (m?.[1] ?? '').split(',').map((x) => x.trim().replace(/^type /, '')).filter(Boolean)
    }
    // 기관 운영 화면(기수 방·집계)은 사용자·프로필·페르소나·소속·멤버십·방별 프로필·명부 표를 읽지 않습니다(인증 회원 수는 member-counts의 count(distinct)만).
    const people = ['users', 'profiles', 'personas', 'institutionAffiliations', 'spaceMemberships', 'roomProfiles', 'directoryEntries', 'follows', 'projects', 'projectMembers']
    expect(dbImports('community/institution-pages.ts').filter((t) => people.includes(t))).toEqual([])
    // 운영진 모듈은 users(계정 상태 확인·운영자용 운영진 목록)만 읽고 소속·프로필·과제는 읽지 않습니다.
    expect(dbImports('institutions/staff.ts').filter((t) => people.includes(t))).toEqual(['users'])
  })
})
