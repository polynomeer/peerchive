import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_DEFAULT_BOARDS,
  OFFICIAL_REQUEST_THRESHOLD,
  ROOM_DEFAULT_BOARDS,
  USER_ROOM_DEFAULT_CAPACITY,
  type CommunityViewer,
  type MembershipFacts,
  type SpaceFacts,
  canCreateRoom,
  canJoinSpace,
  canManageSpace,
  canModerate,
  canPreviewSpace,
  canReadSpace,
  canRemoveSpaceMember,
  canWriteBoard,
  checkRoomCapacity,
  checkSpaceName,
  chooseOwnerSuccessor,
  containsReservedWord,
  defaultBoardsFor,
  defaultJoinPolicy,
  departmentKey,
  effectiveWriteRole,
  isSpaceSlug,
  officialRequestThresholdReached,
} from '../src/index'

const SCHOOL = 'school-a'
const OTHER = 'school-b'
const CSE = departmentKey('컴퓨터공학과')!

const viewer = (overrides: Partial<CommunityViewer> = {}): CommunityViewer => ({
  userId: 'u1',
  status: 'active',
  operator: false,
  affiliations: [{ schoolId: SCHOOL, departmentKey: CSE }],
  ...overrides,
})
const unaffiliated = viewer({ affiliations: [] })
const otherSchool = viewer({ affiliations: [{ schoolId: OTHER, departmentKey: null }] })
const operator = viewer({ operator: true, affiliations: [] })

const room = (overrides: Partial<SpaceFacts> = {}): SpaceFacts => ({
  kind: 'user_room',
  schoolId: null,
  departmentKey: null,
  discovery: 'listed',
  joinPolicy: 'open',
  status: 'active',
  capacity: 300,
  activeMembers: 1,
  ...overrides,
})
const officialSchool = room({ kind: 'official_school', schoolId: SCHOOL, capacity: 100000 })
const officialDept = room({ kind: 'official_department', schoolId: SCHOOL, departmentKey: CSE, capacity: 100000 })
const m = (role: MembershipFacts['role'], status: MembershipFacts['status'] = 'active'): MembershipFacts => ({ role, status })
const board = { kind: 'free' as const, writeRole: 'member' as const }
const notice = { kind: 'notice' as const, writeRole: 'member' as const }

describe('space names', () => {
  it('normalizes, enforces length and rejects reserved words in any spacing/case/width', () => {
    expect(checkSpaceName('  12학번   컴공 동기방 ')).toEqual({ ok: true, value: '12학번 컴공 동기방' })
    expect(checkSpaceName('운영체제 스터디')).toEqual({ ok: true, value: '운영체제 스터디' })
    expect(checkSpaceName('영남대 컴공 모임')).toMatchObject({ ok: true })
    for (const bad of ['공식 컴공방', '공 식', '총학생회 공지', '컴공 학생회', '운영자 모임', '관리자방', 'Peer-chive 팬클럽', 'ＯＦＦＩＣＩＡＬ room', 'Admin room', 'PEERCHIVE']) {
      expect(checkSpaceName(bad), bad).toEqual({ ok: false, reason: 'reserved' })
      expect(containsReservedWord(bad), bad).toBe(true)
    }
    expect(checkSpaceName('')).toEqual({ ok: false, reason: 'required' })
    expect(checkSpaceName('   ')).toEqual({ ok: false, reason: 'required' })
    expect(checkSpaceName(undefined)).toEqual({ ok: false, reason: 'required' })
    expect(checkSpaceName(12)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkSpaceName('가'.repeat(41))).toEqual({ ok: false, reason: 'too_long' })
    expect(checkSpaceName('a\u0007b')).toEqual({ ok: false, reason: 'invalid' })
    // 공식 페이지(운영자)는 예약어 검사를 하지 않음
    expect(checkSpaceName('공식 페이지', { reserved: false })).toMatchObject({ ok: true })
  })

  it('keys departments like self-reported labels and validates slugs', () => {
    expect(departmentKey(' 컴퓨터 공학과 ')).toBe(departmentKey('컴퓨터공학과'))
    expect(departmentKey('')).toBeNull()
    expect(departmentKey(null)).toBeNull()
    expect(isSpaceSlug('abc123xyz0')).toBe(true)
    for (const bad of ['ABC123XYZ0', 'abc', 'abc123xyz01', '../etc/pa', 12]) expect(isSpaceSlug(bad)).toBe(false)
  })

  it('defaults: real rooms need approval, official boards set with moderator-only notice, rooms get one board', () => {
    expect(defaultJoinPolicy('real')).toBe('approval')
    expect(defaultJoinPolicy('display')).toBe('open')
    expect(defaultJoinPolicy('anonymous')).toBe('open')
    expect(OFFICIAL_DEFAULT_BOARDS.map((b) => b.kind)).toEqual(['free', 'freshmen', 'alumni', 'question', 'info', 'recruiting', 'notice'])
    expect(OFFICIAL_DEFAULT_BOARDS.find((b) => b.kind === 'notice')?.writeRole).toBe('moderator')
    expect(defaultBoardsFor('official_department')).toBe(OFFICIAL_DEFAULT_BOARDS)
    expect(defaultBoardsFor('user_room')).toBe(ROOM_DEFAULT_BOARDS)
    expect(ROOM_DEFAULT_BOARDS).toEqual([{ kind: 'general', title: '게시판', writeRole: 'member' }])
    expect(effectiveWriteRole('notice', 'member')).toBe('moderator')
    expect(effectiveWriteRole('free', 'moderator')).toBe('moderator')
  })

  it('capacity: default 300, larger requests become 300 + operator review', () => {
    expect(checkRoomCapacity(undefined)).toEqual({ ok: true, capacity: USER_ROOM_DEFAULT_CAPACITY, requested: null })
    expect(checkRoomCapacity(50)).toEqual({ ok: true, capacity: 50, requested: null })
    expect(checkRoomCapacity(300)).toEqual({ ok: true, capacity: 300, requested: null })
    expect(checkRoomCapacity(301)).toEqual({ ok: true, capacity: 300, requested: 301 })
    expect(checkRoomCapacity(1)).toEqual({ ok: false, reason: 'too_small' })
    expect(checkRoomCapacity(2001)).toEqual({ ok: false, reason: 'too_large' })
    expect(checkRoomCapacity(2.5)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkRoomCapacity('300')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('canReadSpace / canPreviewSpace', () => {
  it('official pages derive reading from an active school affiliation, never membership', () => {
    expect(canReadSpace(viewer(), officialSchool, null)).toBe(true)
    expect(canReadSpace(viewer({ affiliations: [{ schoolId: SCHOOL, departmentKey: null }] }), officialDept, null)).toBe(true)
    expect(canReadSpace(otherSchool, officialSchool, null)).toBe(false)
    expect(canReadSpace(unaffiliated, officialSchool, null)).toBe(false)
    // 모더레이터 멤버십이 있어도 학교 인증이 없으면 못 읽음
    expect(canReadSpace(otherSchool, officialSchool, m('moderator'))).toBe(false)
    expect(canReadSpace(viewer({ status: 'suspended' }), officialSchool, null)).toBe(false)
    expect(canReadSpace(operator, officialSchool, null)).toBe(true)
  })

  it('user rooms are readable only by active members; operators get no implicit read', () => {
    expect(canReadSpace(viewer(), room(), m('member'))).toBe(true)
    expect(canReadSpace(viewer(), room({ status: 'archived' }), m('member'))).toBe(true)
    expect(canReadSpace(viewer(), room({ status: 'restricted' }), m('owner'))).toBe(true)
    for (const status of ['pending', 'left', 'removed'] as const) expect(canReadSpace(viewer(), room(), m('member', status))).toBe(false)
    expect(canReadSpace(viewer(), room(), null)).toBe(false)
    expect(canReadSpace(operator, room(), null)).toBe(false)
    expect(canReadSpace(viewer({ status: 'deleted' }), room(), m('owner'))).toBe(false)
  })

  it('previews only joinable active rooms for eligible viewers (listed or link-only), never invite-only/archived/other school', () => {
    expect(canPreviewSpace(viewer(), room(), null)).toBe(true)
    expect(canPreviewSpace(viewer(), room({ discovery: 'unlisted' }), null)).toBe(true)
    expect(canPreviewSpace(viewer(), room({ joinPolicy: 'invite' }), null)).toBe(false)
    expect(canPreviewSpace(viewer(), room({ joinPolicy: 'invite' }), m('member', 'pending'))).toBe(true)
    expect(canPreviewSpace(viewer(), room({ status: 'archived' }), null)).toBe(false)
    expect(canPreviewSpace(viewer(), room({ status: 'restricted' }), null)).toBe(false)
    expect(canPreviewSpace(unaffiliated, room(), null)).toBe(false)
    expect(canPreviewSpace(otherSchool, room({ schoolId: SCHOOL }), null)).toBe(false)
    expect(canPreviewSpace(viewer(), room({ schoolId: SCHOOL }), null)).toBe(true)
    expect(canPreviewSpace(viewer(), room(), m('member', 'removed'))).toBe(false)
    expect(canPreviewSpace(viewer(), room({ kind: 'study_room', joinPolicy: 'invite' }), null)).toBe(false)
    expect(canPreviewSpace(viewer(), officialSchool, null)).toBe(false)
  })
})

describe('canJoinSpace', () => {
  it('open → active, approval → pending, invite-only needs a link; invites work for any policy', () => {
    expect(canJoinSpace(viewer(), room(), null, 'self')).toEqual({ ok: true, status: 'active' })
    expect(canJoinSpace(viewer(), room({ joinPolicy: 'approval' }), null, 'self')).toEqual({ ok: true, status: 'pending' })
    expect(canJoinSpace(viewer(), room({ joinPolicy: 'invite' }), null, 'self')).toEqual({ ok: false, reason: 'invite_only' })
    expect(canJoinSpace(viewer(), room({ joinPolicy: 'invite' }), null, 'invite')).toEqual({ ok: true, status: 'active' })
    expect(canJoinSpace(viewer(), room({ joinPolicy: 'approval' }), m('member', 'pending'), 'invite')).toEqual({ ok: true, status: 'active' })
    expect(canJoinSpace(viewer(), room(), m('member', 'left'), 'self')).toEqual({ ok: true, status: 'active' })
  })

  it('refuses duplicates, removed members (except by invite), full rooms, school mismatch and official pages', () => {
    expect(canJoinSpace(viewer(), room(), m('member'), 'self')).toEqual({ ok: false, reason: 'already_member' })
    expect(canJoinSpace(viewer(), room(), m('member'), 'invite')).toEqual({ ok: false, reason: 'already_member' })
    expect(canJoinSpace(viewer(), room({ joinPolicy: 'approval' }), m('member', 'pending'), 'self')).toEqual({ ok: false, reason: 'already_pending' })
    expect(canJoinSpace(viewer(), room(), m('member', 'removed'), 'self')).toEqual({ ok: false, reason: 'removed' })
    expect(canJoinSpace(viewer(), room(), m('member', 'removed'), 'invite')).toEqual({ ok: true, status: 'active' })
    expect(canJoinSpace(viewer(), room({ capacity: 3, activeMembers: 3 }), null, 'self')).toEqual({ ok: false, reason: 'full' })
    expect(canJoinSpace(viewer(), room({ capacity: 3, activeMembers: 3 }), null, 'invite')).toEqual({ ok: false, reason: 'full' })
    // 승인 대기는 정원을 쓰지 않음(승인 때 다시 확인)
    expect(canJoinSpace(viewer(), room({ joinPolicy: 'approval', capacity: 3, activeMembers: 3 }), null, 'self')).toEqual({ ok: true, status: 'pending' })
    expect(canJoinSpace(otherSchool, room({ schoolId: SCHOOL }), null, 'invite')).toEqual({ ok: false, reason: 'not_found' })
    expect(canJoinSpace(unaffiliated, room(), null, 'self')).toEqual({ ok: false, reason: 'not_found' })
    expect(canJoinSpace(viewer(), room({ status: 'archived' }), null, 'invite')).toEqual({ ok: false, reason: 'not_found' })
    expect(canJoinSpace(viewer(), room({ status: 'restricted' }), null, 'self')).toEqual({ ok: false, reason: 'not_found' })
    expect(canJoinSpace(viewer(), officialSchool, null, 'self')).toEqual({ ok: false, reason: 'not_joinable' })
    expect(canJoinSpace(viewer(), room({ kind: 'study_room', joinPolicy: 'invite' }), null, 'self')).toEqual({ ok: false, reason: 'invite_only' })
    expect(canJoinSpace(viewer(), room({ kind: 'study_room', joinPolicy: 'invite' }), null, 'invite')).toEqual({ ok: true, status: 'active' })
  })

  it('room creation needs an active affiliation (and that school when linked)', () => {
    expect(canCreateRoom(viewer(), null)).toBe(true)
    expect(canCreateRoom(viewer(), SCHOOL)).toBe(true)
    expect(canCreateRoom(viewer(), OTHER)).toBe(false)
    expect(canCreateRoom(unaffiliated, null)).toBe(false)
    expect(canCreateRoom(operator, null)).toBe(false)
    expect(canCreateRoom(viewer({ status: 'suspended' }), null)).toBe(false)
    expect(canCreateRoom(null, null)).toBe(false)
  })
})

describe('canWriteBoard / canModerate', () => {
  it('official school page: affiliated members write; notice is moderator-only; write restriction (removed) blocks', () => {
    expect(canWriteBoard(viewer(), officialSchool, null, board)).toBe(true)
    expect(canWriteBoard(otherSchool, officialSchool, null, board)).toBe(false)
    expect(canWriteBoard(viewer(), officialSchool, null, notice)).toBe(false)
    expect(canWriteBoard(viewer(), officialSchool, m('moderator'), notice)).toBe(true)
    expect(canWriteBoard(operator, officialSchool, null, notice)).toBe(true)
    expect(canWriteBoard(viewer(), officialSchool, m('member', 'removed'), board)).toBe(false)
    expect(canWriteBoard(viewer({ communityWriteSuspended: true }), officialSchool, null, board)).toBe(false)
    expect(canWriteBoard(viewer(), { ...officialSchool, status: 'restricted' }, null, board)).toBe(false)
  })

  it('official department page: school members read, only the matching self-reported department writes', () => {
    const otherDept = viewer({ affiliations: [{ schoolId: SCHOOL, departmentKey: departmentKey('경영학과') }] })
    const noDept = viewer({ affiliations: [{ schoolId: SCHOOL, departmentKey: null }] })
    expect(canReadSpace(otherDept, officialDept, null)).toBe(true)
    expect(canWriteBoard(viewer(), officialDept, null, board)).toBe(true)
    expect(canWriteBoard(otherDept, officialDept, null, board)).toBe(false)
    expect(canWriteBoard(noDept, officialDept, null, board)).toBe(false)
    expect(canWriteBoard(viewer({ affiliations: [{ schoolId: OTHER, departmentKey: CSE }] }), officialDept, null, board)).toBe(false)
  })

  it('user rooms: active members write, notice needs moderator/admin/owner, archived rooms are read-only', () => {
    expect(canWriteBoard(viewer(), room(), m('member'), board)).toBe(true)
    expect(canWriteBoard(viewer(), room(), m('member', 'pending'), board)).toBe(false)
    expect(canWriteBoard(viewer(), room(), null, board)).toBe(false)
    expect(canWriteBoard(viewer(), room(), m('member'), notice)).toBe(false)
    for (const role of ['moderator', 'admin', 'owner'] as const) expect(canWriteBoard(viewer(), room(), m(role), notice)).toBe(true)
    expect(canWriteBoard(viewer(), room({ status: 'archived' }), m('owner'), board)).toBe(false)
    expect(canWriteBoard(operator, room(), null, board)).toBe(false)
    expect(canWriteBoard(viewer(), room(), m('member'), { kind: 'general', writeRole: 'moderator' })).toBe(false)
  })

  it('moderation: official moderators/operators; room owner/admin/moderator; operators not in rooms', () => {
    expect(canModerate(viewer(), officialSchool, m('moderator'))).toBe(true)
    expect(canModerate(viewer(), officialSchool, null)).toBe(false)
    expect(canModerate(operator, officialSchool, null)).toBe(true)
    expect(canModerate(viewer(), room(), m('moderator'))).toBe(true)
    expect(canModerate(viewer(), room(), m('member'))).toBe(false)
    expect(canModerate(operator, room(), null)).toBe(false)
  })
})

describe('canManageSpace', () => {
  it('rooms: owner everything, admin settings/boards/requests/remove/invite, members nothing; official: operators only', () => {
    expect(canManageSpace(viewer(), room(), m('owner'), 'change_roles')).toBe(true)
    expect(canManageSpace(viewer(), room(), m('owner'), 'archive')).toBe(true)
    for (const action of ['update_settings', 'manage_boards', 'review_requests', 'remove_members', 'invite'] as const) {
      expect(canManageSpace(viewer(), room(), m('admin'), action), action).toBe(true)
      expect(canManageSpace(viewer(), room(), m('moderator'), action), action).toBe(false)
      expect(canManageSpace(viewer(), room(), m('member'), action), action).toBe(false)
    }
    expect(canManageSpace(viewer(), room(), m('admin'), 'change_roles')).toBe(false)
    expect(canManageSpace(viewer(), room(), m('admin'), 'archive')).toBe(false)
    expect(canManageSpace(viewer(), room({ status: 'archived' }), m('owner'), 'update_settings')).toBe(false)
    expect(canManageSpace(viewer(), room({ status: 'restricted' }), m('owner'), 'invite')).toBe(false)
    expect(canManageSpace(operator, room(), null, 'archive')).toBe(false)
    expect(canManageSpace(operator, officialSchool, null, 'manage_boards')).toBe(true)
    expect(canManageSpace(operator, officialSchool, null, 'invite')).toBe(false)
    expect(canManageSpace(viewer(), officialSchool, m('moderator'), 'manage_boards')).toBe(false)
  })

  it('removal: owner removes anyone but owner, admin only moderators/members', () => {
    expect(canRemoveSpaceMember('owner', 'admin')).toBe(true)
    expect(canRemoveSpaceMember('owner', 'owner')).toBe(false)
    expect(canRemoveSpaceMember('admin', 'member')).toBe(true)
    expect(canRemoveSpaceMember('admin', 'moderator')).toBe(true)
    expect(canRemoveSpaceMember('admin', 'admin')).toBe(false)
    expect(canRemoveSpaceMember('moderator', 'member')).toBe(false)
  })
})

describe('owner succession', () => {
  const t = (day: number) => new Date(Date.UTC(2026, 9, day))
  it('oldest active admin, then oldest other active member, else null (archive)', () => {
    const members = [
      { userId: 'owner', role: 'owner' as const, status: 'active' as const, joinedAt: t(1) },
      { userId: 'm-old', role: 'member' as const, status: 'active' as const, joinedAt: t(2) },
      { userId: 'a-new', role: 'admin' as const, status: 'active' as const, joinedAt: t(5) },
      { userId: 'a-old', role: 'admin' as const, status: 'active' as const, joinedAt: t(4) },
      { userId: 'a-left', role: 'admin' as const, status: 'left' as const, joinedAt: t(1) },
    ]
    expect(chooseOwnerSuccessor(members, 'owner')).toBe('a-old')
    const noAdmins = members.filter((x) => x.role !== 'admin')
    expect(chooseOwnerSuccessor(noAdmins, 'owner')).toBe('m-old')
    const withModerator = [...noAdmins, { userId: 'mod', role: 'moderator' as const, status: 'active' as const, joinedAt: t(1) }]
    expect(chooseOwnerSuccessor(withModerator, 'owner')).toBe('mod')
    expect(chooseOwnerSuccessor([members[0]!, { userId: 'p', role: 'member', status: 'pending', joinedAt: null }], 'owner')).toBeNull()
    // 같은 시각이면 userId 순으로 결정적
    expect(chooseOwnerSuccessor([{ userId: 'b', role: 'member', status: 'active', joinedAt: t(3) }, { userId: 'a', role: 'member', status: 'active', joinedAt: t(3) }], 'x')).toBe('a')
  })
})

describe('official page requests', () => {
  it('threshold is 10 distinct requesters or a student council flag', () => {
    expect(OFFICIAL_REQUEST_THRESHOLD).toBe(10)
    expect(officialRequestThresholdReached(9, false)).toBe(false)
    expect(officialRequestThresholdReached(10, false)).toBe(true)
    expect(officialRequestThresholdReached(1, true)).toBe(true)
  })
})
