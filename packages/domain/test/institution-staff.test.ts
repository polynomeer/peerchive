import { describe, expect, it } from 'vitest'
import {
  INSTITUTION_PAGE_DEFAULT_BOARDS,
  SPACE_MANAGE_ACTIONS,
  type CommunityViewer,
  type MembershipFacts,
  type SpaceFacts,
  canJoinSpace,
  canManageSpace,
  canModerate,
  canPreviewSpace,
  canReadSpace,
  canResolveAuthor,
  canWriteBoard,
  hasCohortAffiliation,
  isCohortRoom,
  isInstitutionStaffFor,
  meetsRoomAffiliation,
} from '../src/index'

// I-02(ADR 0044): 기관 페이지·기수 방·기관 운영진 정책.
const CAMP = 'camp-a'
const OTHER = 'camp-b'
const C1 = 'cohort-1'
const C2 = 'cohort-2'

const viewer = (overrides: Partial<CommunityViewer> = {}): CommunityViewer => ({
  userId: 'u1',
  status: 'active',
  operator: false,
  affiliations: [],
  ...overrides,
})
const space = (overrides: Partial<SpaceFacts> = {}): SpaceFacts => ({
  kind: 'user_room',
  schoolId: null,
  departmentKey: null,
  discovery: 'listed',
  joinPolicy: 'open',
  status: 'active',
  capacity: 2000,
  activeMembers: 3,
  ...overrides,
})
const m = (role: MembershipFacts['role'], status: MembershipFacts['status'] = 'active'): MembershipFacts => ({ role, status })

const page = space({ kind: 'official_school', schoolId: CAMP, capacity: 100000 })
const otherPage = space({ kind: 'official_school', schoolId: OTHER, capacity: 100000 })
const cohortRoom = space({ schoolId: CAMP, cohortId: C1 })
const linkedRoom = space({ schoolId: CAMP })
const staff = viewer({ institutionStaffSchoolIds: [CAMP] })
const member1 = viewer({ affiliations: [{ schoolId: CAMP, departmentKey: null, cohortId: C1 }] })
const member2 = viewer({ affiliations: [{ schoolId: CAMP, departmentKey: null, cohortId: C2 }] })
const memberNoCohort = viewer({ affiliations: [{ schoolId: CAMP, departmentKey: null, cohortId: null }] })

describe('institution staff policy (I-02)', () => {
  it('staff powers apply only to their own institution page and cohort rooms', () => {
    expect(isInstitutionStaffFor(staff, page)).toBe(true)
    expect(isInstitutionStaffFor(staff, cohortRoom)).toBe(true)
    expect(isInstitutionStaffFor(staff, otherPage)).toBe(false)
    expect(isInstitutionStaffFor(staff, linkedRoom)).toBe(false)
    expect(isInstitutionStaffFor(staff, space({ kind: 'official_department', schoolId: CAMP, departmentKey: 'x' }))).toBe(false)
    expect(isInstitutionStaffFor({ ...staff, status: 'suspended' }, page)).toBe(false)
    expect(isInstitutionStaffFor(viewer(), page)).toBe(false)
  })

  it('on the institution page: read, moderate, notices, settings and boards; never archive, member writes or author lookup', () => {
    expect(canReadSpace(staff, page, null)).toBe(true)
    expect(canModerate(staff, page, null)).toBe(true)
    expect(canWriteBoard(staff, page, null, { kind: 'notice', writeRole: 'moderator' })).toBe(true)
    expect(canWriteBoard(staff, page, null, { kind: 'free', writeRole: 'member' })).toBe(false)
    const allowed = SPACE_MANAGE_ACTIONS.filter((a) => canManageSpace(staff, page, null, a))
    expect(allowed).toEqual(['update_settings', 'manage_boards'])
    expect(canResolveAuthor(staff)).toBe(false)
    // 다른 기관
    expect(canReadSpace(staff, otherPage, null)).toBe(false)
    expect(canModerate(staff, otherPage, null)).toBe(false)
    expect(SPACE_MANAGE_ACTIONS.filter((a) => canManageSpace(staff, otherPage, null, a))).toEqual([])
    // 보관·제한된 페이지는 관리 없음
    expect(canManageSpace(staff, { ...page, status: 'archived' }, null, 'manage_boards')).toBe(false)
  })

  it('staff permissions never exceed a room owner: every action staff may take, an owner of an ordinary room may take too', () => {
    for (const action of SPACE_MANAGE_ACTIONS) {
      if (canManageSpace(staff, cohortRoom, null, action)) expect(canManageSpace(viewer(), space(), m('owner'), action)).toBe(true)
    }
    expect(SPACE_MANAGE_ACTIONS.filter((a) => canManageSpace(staff, cohortRoom, null, a))).toEqual(['update_settings', 'manage_boards'])
  })

  it('cohort rooms: only that institution + cohort (any method) can preview, join and read; staff read to moderate', () => {
    expect(isCohortRoom(cohortRoom)).toBe(true)
    expect(isCohortRoom(linkedRoom)).toBe(false)
    expect(hasCohortAffiliation(member1, CAMP, C1)).toBe(true)
    expect(meetsRoomAffiliation(member1, cohortRoom)).toBe(true)
    for (const v of [member2, memberNoCohort, staff, viewer({ affiliations: [{ schoolId: OTHER, departmentKey: null, cohortId: C1 }] })]) {
      expect(meetsRoomAffiliation(v, cohortRoom)).toBe(false)
      expect(canPreviewSpace(v, cohortRoom, null)).toBe(false)
      expect(canJoinSpace(v, cohortRoom, null, 'self')).toEqual({ ok: false, reason: 'not_found' })
      expect(canJoinSpace(v, cohortRoom, null, 'invite')).toEqual({ ok: false, reason: 'not_found' })
    }
    expect(canJoinSpace(member1, cohortRoom, null, 'self')).toEqual({ ok: true, status: 'active' })
    expect(canReadSpace(member1, cohortRoom, m('member'))).toBe(true)
    // 인증이 끝나면 멤버십이 남아도 읽지 못함
    expect(canReadSpace(memberNoCohort, cohortRoom, m('member'))).toBe(false)
    // 운영진: 읽기·운영 조치·공지, 일반 글은 못 씀
    expect(canReadSpace(staff, cohortRoom, null)).toBe(true)
    expect(canModerate(staff, cohortRoom, null)).toBe(true)
    expect(canWriteBoard(staff, cohortRoom, null, { kind: 'notice', writeRole: 'moderator' })).toBe(true)
    expect(canWriteBoard(staff, cohortRoom, null, { kind: 'general', writeRole: 'member' })).toBe(false)
    // 기관 연결 사용자 방에는 아무 권한 없음
    expect(canReadSpace(staff, linkedRoom, null)).toBe(false)
    expect(canModerate(staff, linkedRoom, null)).toBe(false)
  })

  it('institution page boards: no freshmen board, alumni board titled 수료생, notice moderator-only', () => {
    expect(INSTITUTION_PAGE_DEFAULT_BOARDS.map((b) => b.kind)).not.toContain('freshmen')
    expect(INSTITUTION_PAGE_DEFAULT_BOARDS.find((b) => b.kind === 'alumni')!.title).toBe('수료생')
    expect(INSTITUTION_PAGE_DEFAULT_BOARDS.find((b) => b.kind === 'notice')!.writeRole).toBe('moderator')
  })
})
