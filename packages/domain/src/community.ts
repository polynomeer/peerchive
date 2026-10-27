/**
 * 캠퍼스 커뮤니티 공간·게시판·멤버십·가입 방식 규칙 (C-02, PROOFU_EVOLUTION_PLAN §8.9.2–§8.9.4, SYSTEM_DESIGN §6.7 CommunitySpace·
 * SpaceMembership·Board·SpaceOpeningRequest·§8.1·§8.2, DELIVERY_PLAN §4.1 C-02, ADR 0019).
 *
 * - 공간 종류: 공식 학교 페이지·공식 학과 페이지(운영자만 개설, `공식` 배지, 이름 표시 `anonymous` 고정), 사용자 방(로그인 + active 학교 인증
 *   하나 이상이면 누구나), 스터디 방(모집 마감으로 만들어짐, C-07; 여기서는 종류와 규칙만).
 * - **공식 페이지의 읽기·쓰기 자격은 멤버십이 아니라 그 학교의 active 학교 인증에서 나옵니다.** 공식 페이지의 멤버십은 모더레이터 지정과
 *   학과 쓰기 제한(status removed)에만 씁니다. 학과 페이지는 학교 인증 구성원이 읽고, 자기 신고 학과의 키가 같은 사람이 씁니다.
 * - 사용자 방·스터디 방은 active 멤버만 읽습니다. 운영자에게도 암묵적인 읽기 권한이 없습니다(ADR 0010·0015와 같은 원칙). 학교를 연결한 방은
 *   그 학교 인증 계정만 들어오고, 연결하지 않은 방은 학교 인증이 하나라도 있으면 들어옵니다.
 * - 가입: open → active, approval → pending(방장·admin 승인), invite → 초대 링크로만. 정원(기본 300)을 넘으면 409. 방장이 떠나면 가장 오래된
 *   admin → 가장 오래된 다른 active 멤버 순으로 넘기고, 없으면 보관(archived).
 * - 상태: archived(보관: 읽기만, 가입·쓰기·관리 없음), restricted(운영 조치: 읽기만, 목록·가입·쓰기·관리 없음, 운영자만 해제).
 * - 글쓰기 권한(canWriteBoard)만 여기서 정합니다. 실제 글·댓글은 C-04, 이름 표시 방식 변경은 C-03, 이용 제한(제재)은 C-06이며
 *   `communityWriteSuspended` 자리를 남겨 둡니다.
 *
 * 런타임 의존성 없음.
 */
import { labelKey, normalizeLabel } from './courses'

export const SPACE_KINDS = ['official_school', 'official_department', 'user_room', 'study_room'] as const
export type SpaceKind = (typeof SPACE_KINDS)[number]
export const OFFICIAL_SPACE_KINDS: readonly SpaceKind[] = ['official_school', 'official_department']
export const NAME_MODES = ['real', 'display', 'anonymous'] as const
export type NameMode = (typeof NAME_MODES)[number]
export const SPACE_DISCOVERIES = ['listed', 'unlisted'] as const
export type SpaceDiscovery = (typeof SPACE_DISCOVERIES)[number]
export const JOIN_POLICIES = ['open', 'approval', 'invite'] as const
export type JoinPolicy = (typeof JOIN_POLICIES)[number]
export const SPACE_STATUSES = ['active', 'archived', 'restricted'] as const
export type SpaceStatus = (typeof SPACE_STATUSES)[number]
export const SPACE_ROLES = ['owner', 'admin', 'moderator', 'member'] as const
export type SpaceRole = (typeof SPACE_ROLES)[number]
export const SPACE_MEMBERSHIP_STATUSES = ['pending', 'active', 'left', 'removed'] as const
export type SpaceMembershipStatus = (typeof SPACE_MEMBERSHIP_STATUSES)[number]
export const BOARD_KINDS = ['free', 'freshmen', 'alumni', 'question', 'info', 'recruiting', 'notice', 'general'] as const
export type BoardKind = (typeof BOARD_KINDS)[number]
/** 게시판 쓰기 역할: member(쓸 자격이 있는 모든 사람) / moderator(사용자 방은 moderator·admin·owner, 공식 페이지는 모더레이터·운영자). */
export const BOARD_WRITE_ROLES = ['member', 'moderator'] as const
export type BoardWriteRole = (typeof BOARD_WRITE_ROLES)[number]
export const OFFICIAL_REQUEST_SOURCES = ['student', 'student_council'] as const
export type OfficialRequestSource = (typeof OFFICIAL_REQUEST_SOURCES)[number]

export const SPACE_KIND_LABELS: Readonly<Record<SpaceKind, string>> = {
  official_school: '공식 학교 페이지',
  official_department: '공식 학과 페이지',
  user_room: '사용자 방',
  study_room: '스터디 방',
}
export const NAME_MODE_LABELS: Readonly<Record<NameMode, string>> = { real: '실명', display: '표시명', anonymous: '익명' }
export const JOIN_POLICY_LABELS: Readonly<Record<JoinPolicy, string>> = { open: '자유 가입', approval: '방장 승인', invite: '초대 전용' }
export const SPACE_ROLE_LABELS: Readonly<Record<SpaceRole, string>> = { owner: '방장', admin: '운영진', moderator: '모더레이터', member: '멤버' }
export const BOARD_KIND_LABELS: Readonly<Record<BoardKind, string>> = {
  free: '자유',
  freshmen: '새내기',
  alumni: '졸업생',
  question: '질문',
  info: '정보',
  recruiting: '모집',
  notice: '공지',
  general: '게시판',
}

/** 사용자 방 기본·최대 정원. 더 큰 정원은 요청으로 남기고 운영자가 검토합니다(§8.9.4 "기본 300명, 그 이상은 운영자 검토"). */
export const USER_ROOM_DEFAULT_CAPACITY = 300
export const USER_ROOM_MAX_CAPACITY = 300
/** 운영자 검토로 올릴 수 있는 정원 상한. 그보다 큰 모임은 공식 페이지로 유도합니다. */
export const SPACE_CAPACITY_REVIEW_MAX = 2000
export const SPACE_CAPACITY_MIN = 2
/** 사용자 방이 가질 수 있는 게시판 수(기본 게시판 포함). */
export const MAX_BOARDS_PER_ROOM = 10
export const SPACE_NAME_MAX = 40
export const SPACE_DESCRIPTION_MAX = 300
export const BOARD_TITLE_MAX = 30
/** 공식 페이지 개설 요청 기준 수(서로 다른 인증 계정, 초기안 10). 학생회 요청이면 바로 기준에 이른 것으로 봅니다. */
export const OFFICIAL_REQUEST_THRESHOLD = 10
/** 공간 초대 유효 기간(7일, 과제 초대와 같음). 한 번만 씁니다. */
export const SPACE_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function isOfficialKind(kind: SpaceKind): boolean {
  return kind === 'official_school' || kind === 'official_department'
}

// ── 이름 ─────────────────────────────────────────────────────────────────

/**
 * 사용자 방·스터디 방 이름에 쓸 수 없는 말(§8.9.3 "사용자 방은 이름에 `공식`·`학생회` 등을 쓸 수 없음", DELIVERY_PLAN §9.1 사칭 방지).
 * 비교는 labelKey(NFKC·소문자·공백·구두점 제거)로 하므로 "공 식", "ＯＦＦＩＣＩＡＬ", "Peer-chive"도 걸립니다.
 * `운영`만으로는 막지 않습니다("운영체제 스터디"가 정상 이름이라서). 운영자·운영진·운영팀처럼 운영 주체를 뜻하는 말만 막습니다.
 * 학교 이름은 막지 않습니다("○○대 12학번 컴공 동기방"이 정상 이름). 학교·학과 사칭은 신고(community_space) 대상입니다.
 */
export const RESERVED_SPACE_NAME_WORDS: readonly string[] = [
  '공식',
  '학생회',
  '총학',
  '총학생회',
  '대의원회',
  '운영자',
  '운영진',
  '운영팀',
  '관리자',
  '관리팀',
  '피어카이브',
  'peerchive',
  'proofu',
  'official',
  'admin',
  'administrator',
  'moderator',
  'staff',
]
const RESERVED_KEYS = RESERVED_SPACE_NAME_WORDS.map(labelKey)

export type SpaceNameCheck = { ok: true; value: string } | { ok: false; reason: 'required' | 'too_long' | 'invalid' | 'reserved' }

/** 이름 정리(NFC·공백 하나로) + 길이 + 제어 문자 + (예약어 검사를 켜면) 예약어. 공식 페이지 이름은 운영자가 정하므로 예약어 검사를 하지 않습니다. */
export function checkSpaceName(raw: unknown, options: { reserved: boolean } = { reserved: true }): SpaceNameCheck {
  if (typeof raw !== 'string') return { ok: false, reason: raw === undefined || raw === null ? 'required' : 'invalid' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = normalizeLabel(raw)
  if (!value) return { ok: false, reason: 'required' }
  if ([...value].length > SPACE_NAME_MAX) return { ok: false, reason: 'too_long' }
  if (options.reserved && containsReservedWord(value)) return { ok: false, reason: 'reserved' }
  return { ok: true, value }
}

export function containsReservedWord(name: string): boolean {
  const key = labelKey(name)
  return RESERVED_KEYS.some((word) => word.length > 0 && key.includes(word))
}

/** 학과 키(공식 학과 페이지·학과 쓰기 판정·개설 요청 묶음). 자기 신고 학과(C-01)와 같은 labelKey 규칙. 비면 null. */
export function departmentKey(label: string | null | undefined): string | null {
  if (!label) return null
  const key = labelKey(label)
  return key || null
}

/** 공식 페이지 이름(운영자가 바꾸지 않으면 기본값). */
export function defaultOfficialName(schoolName: string, departmentLabel: string | null): string {
  return departmentLabel ? `${schoolName} ${departmentLabel}` : schoolName
}

/** 이름 표시 방식에 따른 가입 방식 기본값: 실명 방은 승인(§8.9.4 "실명 방은 승인·초대가 기본"), 나머지는 자유 가입. */
export function defaultJoinPolicy(nameMode: NameMode): JoinPolicy {
  return nameMode === 'real' ? 'approval' : 'open'
}

// ── 게시판 ───────────────────────────────────────────────────────────────

export interface BoardTemplate {
  kind: BoardKind
  title: string
  writeRole: BoardWriteRole
}

/** 공식 페이지 기본 게시판(§8.9.3): 자유 / 새내기 / 졸업생 / 질문 / 정보 / 모집 / 공지(모더레이터 전용). */
export const OFFICIAL_DEFAULT_BOARDS: readonly BoardTemplate[] = [
  { kind: 'free', title: '자유', writeRole: 'member' },
  { kind: 'freshmen', title: '새내기', writeRole: 'member' },
  { kind: 'alumni', title: '졸업생', writeRole: 'member' },
  { kind: 'question', title: '질문', writeRole: 'member' },
  { kind: 'info', title: '정보', writeRole: 'member' },
  { kind: 'recruiting', title: '모집', writeRole: 'member' },
  { kind: 'notice', title: '공지', writeRole: 'moderator' },
]

/** 사용자 방·스터디 방 기본 게시판: 하나. 방장·운영진이 MAX_BOARDS_PER_ROOM까지 더합니다. */
export const ROOM_DEFAULT_BOARDS: readonly BoardTemplate[] = [{ kind: 'general', title: '게시판', writeRole: 'member' }]

export function defaultBoardsFor(kind: SpaceKind): readonly BoardTemplate[] {
  return isOfficialKind(kind) ? OFFICIAL_DEFAULT_BOARDS : ROOM_DEFAULT_BOARDS
}

/** 사용자 방에서 더할 수 있는 게시판 종류. 새내기·졸업생은 공식 페이지 전용입니다. */
export const ROOM_BOARD_KINDS: readonly BoardKind[] = ['general', 'free', 'question', 'info', 'recruiting', 'notice']

/** 공지 게시판은 항상 모더레이터 이상만 씁니다(§6.7 Board "`notice`는 moderator 이상만"). 다른 종류는 요청한 값. */
export function effectiveWriteRole(kind: BoardKind, requested: BoardWriteRole): BoardWriteRole {
  return kind === 'notice' ? 'moderator' : requested
}

// ── 정책 함수 ────────────────────────────────────────────────────────────

/** 요청한 사람. 학교 id는 정본(호출자가 병합을 따라감), 학과 키는 그 소속의 자기 신고 학과 키. */
export interface CommunityViewer {
  userId: string
  status: 'active' | 'suspended' | 'deleted'
  operator: boolean
  /** active 학교 인증들(C-01). */
  affiliations: ReadonlyArray<{ schoolId: string; departmentKey: string | null }>
  /** 커뮤니티 이용 제한(C-06 CommunitySanction). 지금은 항상 false이며 C-06이 채웁니다. */
  communityWriteSuspended?: boolean
}

export interface SpaceFacts {
  kind: SpaceKind
  /** 정본 학교 id. 공식 페이지는 항상 있고, 사용자 방은 학교를 연결했을 때만. */
  schoolId: string | null
  departmentKey: string | null
  discovery: SpaceDiscovery
  joinPolicy: JoinPolicy
  status: SpaceStatus
  capacity: number
  /** 지금 active 멤버 수(정원 판정). */
  activeMembers: number
}

export interface MembershipFacts {
  role: SpaceRole
  status: SpaceMembershipStatus
}

export interface BoardFacts {
  kind: BoardKind
  writeRole: BoardWriteRole
}

const isActiveViewer = (v: CommunityViewer | null | undefined): v is CommunityViewer => !!v && v.status === 'active'
const activeMember = (m: MembershipFacts | null | undefined): m is MembershipFacts => !!m && m.status === 'active'

/** 그 학교(정본)의 active 인증이 있는지. */
export function hasSchoolAffiliation(viewer: CommunityViewer, schoolId: string | null): boolean {
  return !!schoolId && viewer.affiliations.some((a) => a.schoolId === schoolId)
}

/** 자기 신고 학과 키가 학과 페이지와 같은 active 인증이 있는지. */
export function hasDepartmentAffiliation(viewer: CommunityViewer, schoolId: string | null, deptKey: string | null): boolean {
  return !!schoolId && !!deptKey && viewer.affiliations.some((a) => a.schoolId === schoolId && a.departmentKey === deptKey)
}

/** 사용자 방에 들어갈 학교 자격: 학교 연결 방은 그 학교 인증, 연결 안 한 방은 아무 학교 인증 하나. */
export function meetsRoomAffiliation(viewer: CommunityViewer, space: Pick<SpaceFacts, 'schoolId'>): boolean {
  return space.schoolId ? hasSchoolAffiliation(viewer, space.schoolId) : viewer.affiliations.length > 0
}

/** 사용자 방을 만들 수 있는지: active 사용자 + active 학교 인증 하나 이상(+ 학교를 연결하면 그 학교 인증). */
export function canCreateRoom(viewer: CommunityViewer | null | undefined, schoolId: string | null): boolean {
  if (!isActiveViewer(viewer)) return false
  return schoolId ? hasSchoolAffiliation(viewer, schoolId) : viewer.affiliations.length > 0
}

/**
 * 공간 내용(게시판·멤버 수·내 권한)을 읽을 수 있는지. 아니면 API는 404입니다(존재를 숨김).
 * - 공식 페이지: 그 학교 active 인증(학과 페이지도 학교 인증이면 읽음) 또는 운영자.
 * - 사용자 방·스터디 방: active 멤버만(보관·제한 상태여도 멤버는 읽기만). 운영자도 멤버가 아니면 못 읽습니다.
 */
export function canReadSpace(viewer: CommunityViewer | null | undefined, space: SpaceFacts, membership: MembershipFacts | null | undefined): boolean {
  if (!isActiveViewer(viewer)) return false
  if (isOfficialKind(space.kind)) return viewer.operator || hasSchoolAffiliation(viewer, space.schoolId)
  return activeMember(membership)
}

/**
 * 멤버가 아닌 사람에게 방 소개(이름·소개·멤버 수·가입 방식)만 보여 줄 수 있는지(§8.1 "listed 방도 이름·소개·멤버 수만 로그인 사용자에게").
 * 링크를 아는 사람도 볼 수 있게 listed·unlisted 모두 해당합니다(unlisted = 목록에 없고 링크로만). 초대 전용 방·보관·제한된 방·학교 자격이
 * 없는 사람·내보내진 사람은 소개도 404입니다. 승인 대기 중이면 소개를 봅니다.
 */
export function canPreviewSpace(viewer: CommunityViewer | null | undefined, space: SpaceFacts, membership: MembershipFacts | null | undefined): boolean {
  if (!isActiveViewer(viewer)) return false
  if (space.kind !== 'user_room' || space.status !== 'active') return false
  if (!meetsRoomAffiliation(viewer, space)) return false
  if (membership?.status === 'pending') return true
  if (membership?.status === 'removed') return false
  return space.joinPolicy !== 'invite'
}

export type JoinDecision =
  | { ok: true; status: 'active' | 'pending' }
  | {
      ok: false
      reason: 'not_found' | 'not_joinable' | 'already_member' | 'already_pending' | 'removed' | 'invite_only' | 'full'
    }

/**
 * 가입(via self: 가입 버튼, invite: 초대 링크 수락)의 결과.
 * - 공식 페이지는 가입이 없습니다(자격은 학교 인증에서 나옴) → not_joinable. 스터디 방은 초대로만.
 * - 보관·제한된 공간, 학교 자격 없음 → not_found(존재를 드러내지 않음).
 * - 내보내진 사람·승인을 거절당한 사람(removed)은 스스로 다시 들어올 수 없고 새 초대로만 들어옵니다.
 * - 정원은 active가 될 때만 셉니다(승인 대기는 승인할 때 다시 확인).
 */
export function canJoinSpace(
  viewer: CommunityViewer | null | undefined,
  space: SpaceFacts,
  membership: MembershipFacts | null | undefined,
  via: 'self' | 'invite',
): JoinDecision {
  if (!isActiveViewer(viewer)) return { ok: false, reason: 'not_found' }
  if (isOfficialKind(space.kind)) return { ok: false, reason: 'not_joinable' }
  if (space.status !== 'active') return { ok: false, reason: 'not_found' }
  if (!meetsRoomAffiliation(viewer, space)) return { ok: false, reason: 'not_found' }
  if (membership?.status === 'active') return { ok: false, reason: 'already_member' }
  let status: 'active' | 'pending'
  if (via === 'invite') status = 'active'
  else {
    if (space.kind === 'study_room') return { ok: false, reason: 'invite_only' }
    if (membership?.status === 'removed') return { ok: false, reason: 'removed' }
    if (membership?.status === 'pending') return { ok: false, reason: 'already_pending' }
    if (space.joinPolicy === 'invite') return { ok: false, reason: 'invite_only' }
    status = space.joinPolicy === 'open' ? 'active' : 'pending'
  }
  if (status === 'active' && space.activeMembers >= space.capacity) return { ok: false, reason: 'full' }
  return { ok: true, status }
}

/** 승인 대기를 승인할 수 있는지(정원). */
export function hasRoomFor(space: Pick<SpaceFacts, 'capacity' | 'activeMembers'>): boolean {
  return space.activeMembers < space.capacity
}

const ROOM_MODERATOR_ROLES: readonly SpaceRole[] = ['owner', 'admin', 'moderator']

/**
 * 공간 운영(글 숨김·공지 고정 등, C-04~C-06에서 씀)을 할 수 있는지.
 * 공식 페이지: active 모더레이터 멤버십 또는 운영자. 사용자 방: active owner·admin·moderator. 운영자의 사용자 방 조치는 운영 화면(신고 처리)으로만 합니다.
 */
export function canModerate(viewer: CommunityViewer | null | undefined, space: SpaceFacts, membership: MembershipFacts | null | undefined): boolean {
  if (!isActiveViewer(viewer) || !canReadSpace(viewer, space, membership)) return false
  if (isOfficialKind(space.kind)) return viewer.operator || (activeMember(membership) && membership.role === 'moderator')
  return activeMember(membership) && ROOM_MODERATOR_ROLES.includes(membership.role)
}

/**
 * 게시판에 글을 쓸 자격(실제 글은 C-04). active 공간 + 읽기 자격 + 이용 제한 없음(C-06 자리) +
 * - 공식 학교 페이지: 그 학교 인증(학과 페이지는 같은 학과 키의 인증), 학과 쓰기 제한(removed 멤버십)이 없을 것.
 * - 사용자 방·스터디 방: active 멤버.
 * - writeRole moderator(공지 등): canModerate.
 */
export function canWriteBoard(
  viewer: CommunityViewer | null | undefined,
  space: SpaceFacts,
  membership: MembershipFacts | null | undefined,
  board: BoardFacts,
): boolean {
  if (!isActiveViewer(viewer) || space.status !== 'active') return false
  if (viewer.communityWriteSuspended) return false
  if (!canReadSpace(viewer, space, membership)) return false
  if (effectiveWriteRole(board.kind, board.writeRole) === 'moderator') return canModerate(viewer, space, membership)
  if (space.kind === 'official_school') return hasSchoolAffiliation(viewer, space.schoolId) && membership?.status !== 'removed'
  if (space.kind === 'official_department') {
    return hasDepartmentAffiliation(viewer, space.schoolId, space.departmentKey) && membership?.status !== 'removed'
  }
  return activeMember(membership)
}

export const SPACE_MANAGE_ACTIONS = [
  'update_settings',
  'manage_boards',
  'review_requests',
  'remove_members',
  'invite',
  'change_roles',
  'archive',
] as const
export type SpaceManageAction = (typeof SPACE_MANAGE_ACTIONS)[number]

/**
 * 공간 관리 권한. active 공간만(보관·제한되면 아무도 관리하지 못하고, 제한은 운영자만 풂).
 * - 공식 페이지: 설정·게시판·보관은 운영자만. 가입·초대·역할이 없습니다(모더레이터 지정은 운영자 API).
 * - 사용자 방: 설정·게시판·승인·내보내기·초대는 owner·admin, 역할 변경·보관은 owner.
 */
export function canManageSpace(
  viewer: CommunityViewer | null | undefined,
  space: SpaceFacts,
  membership: MembershipFacts | null | undefined,
  action: SpaceManageAction,
): boolean {
  if (!isActiveViewer(viewer) || space.status !== 'active') return false
  if (isOfficialKind(space.kind)) {
    return viewer.operator && (action === 'update_settings' || action === 'manage_boards' || action === 'archive')
  }
  if (!activeMember(membership)) return false
  switch (action) {
    case 'change_roles':
    case 'archive':
      return membership.role === 'owner'
    default:
      return membership.role === 'owner' || membership.role === 'admin'
  }
}

/** 내보낼 수 있는 대상인지: owner는 owner 말고 모두, admin은 moderator·member만. 자기 자신은 나가기로. */
export function canRemoveSpaceMember(actorRole: SpaceRole, targetRole: SpaceRole): boolean {
  if (actorRole === 'owner') return targetRole !== 'owner'
  if (actorRole === 'admin') return targetRole === 'moderator' || targetRole === 'member'
  return false
}

/** 역할 변경으로 줄 수 있는 역할. owner를 주면 소유권 이전(이전 owner는 admin). */
export const ASSIGNABLE_SPACE_ROLES: readonly SpaceRole[] = ['owner', 'admin', 'moderator', 'member']

// ── 방장 승계 ────────────────────────────────────────────────────────────

export interface SuccessionCandidate {
  userId: string
  role: SpaceRole
  status: SpaceMembershipStatus
  joinedAt: Date | null
}

/**
 * 방장이 떠날 때(나가기·탈퇴 정리) 넘겨받을 사람: 가장 오래된 active admin → 가장 오래된 다른 active 멤버(moderator·member).
 * 없으면 null(공간을 archived로). 같은 시각이면 userId 순으로 정해 결과가 항상 같습니다.
 */
export function chooseOwnerSuccessor(members: readonly SuccessionCandidate[], leavingUserId: string): string | null {
  const eligible = members.filter((m) => m.status === 'active' && m.userId !== leavingUserId && m.role !== 'owner' && m.joinedAt)
  const oldest = (list: SuccessionCandidate[]) =>
    [...list].sort((a, b) => a.joinedAt!.getTime() - b.joinedAt!.getTime() || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))[0]
  const admin = oldest(eligible.filter((m) => m.role === 'admin'))
  if (admin) return admin.userId
  return oldest(eligible)?.userId ?? null
}

// ── 정원 ─────────────────────────────────────────────────────────────────

export type CapacityCheck = { ok: true; capacity: number; requested: number | null } | { ok: false; reason: 'invalid' | 'too_small' | 'too_large' }

/**
 * 사용자 방 정원 입력. 없으면 300. 2~300은 그대로, 301~2000은 정원 300으로 만들고 요청값을 운영자 검토로 남깁니다(requested).
 */
export function checkRoomCapacity(raw: unknown): CapacityCheck {
  if (raw === undefined || raw === null) return { ok: true, capacity: USER_ROOM_DEFAULT_CAPACITY, requested: null }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, reason: 'invalid' }
  if (raw < SPACE_CAPACITY_MIN) return { ok: false, reason: 'too_small' }
  if (raw > SPACE_CAPACITY_REVIEW_MAX) return { ok: false, reason: 'too_large' }
  if (raw > USER_ROOM_MAX_CAPACITY) return { ok: true, capacity: USER_ROOM_MAX_CAPACITY, requested: raw }
  return { ok: true, capacity: raw, requested: null }
}

// ── 공식 페이지 개설 요청 ────────────────────────────────────────────────

/** 개설 요청 묶음이 운영자 검토 기준에 이르렀는지: 서로 다른 인증 요청자 10명 이상 또는 학생회 요청. 자동 개설하지 않습니다. */
export function officialRequestThresholdReached(distinctRequesters: number, hasStudentCouncil: boolean): boolean {
  return hasStudentCouncil || distinctRequesters >= OFFICIAL_REQUEST_THRESHOLD
}

// ── 주소(slug) ───────────────────────────────────────────────────────────

/** 공간 주소: 소문자·숫자 10자(추측하기 어려운 무작위 값, unlisted 방의 링크 역할). 서버가 CSPRNG로 만듭니다. */
export const SPACE_SLUG_PATTERN = /^[a-z0-9]{10}$/

export function isSpaceSlug(value: unknown): value is string {
  return typeof value === 'string' && SPACE_SLUG_PATTERN.test(value)
}
