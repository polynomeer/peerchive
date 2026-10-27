/**
 * 모집(팀원 찾기·스터디 모집)·지원·마감 규칙 (C-07, PROOFU_EVOLUTION_PLAN §8.8·§8.9.5, SYSTEM_DESIGN §6.7 Recruitment·Application,
 * DELIVERY_PLAN §4.1 C-07 "팀원 찾기와 같은 모집 테이블, 지원자 목록은 모집자만·순위 없음, 마감 시 스터디 방 생성과 초대", ADR 0024).
 *
 * - 한 모집 테이블에 종류(team: 팀원 찾기, study: 스터디 모집)만 다릅니다. 팀원 찾기는 과목이 필수입니다.
 * - 올리는 곳: 공간의 모집 게시판(공식 학교·학과 페이지, 사용자 방) 또는 과목(공간 없이 과목만). 읽기는 그 공간의 읽기 정책(canReadSpace,
 *   C-05 매트릭스) 또는 과목 학교(정본)의 active 인증입니다.
 * - **지원자 목록은 모집자만** 봅니다(모더레이터·운영자도 일반 API로는 못 봄). 지원자는 자기 지원 상태만 봅니다. 지원자를 활동량·포크 수·확인 수로
 *   정렬하거나 꾸미지 않고 **지원 시각 순서**로만 보여 주며(`orderApplications`), 지원자 수는 공개하지 않습니다(모집자에게만).
 * - 거절 사유는 저장하지 않습니다. 거절·마감 때 지원자에게는 같은 문장("모집이 마감되었거나 선정되지 않았습니다")만 보입니다.
 * - 수락은 모집 인원(capacity)까지. 마감은 모집자가 하고 수락한 사람이 한 명 이상 있어야 합니다. 팀원 찾기는 비공개 과제 공간, 스터디 모집은 스터디 방을
 *   만들고 수락한 사람에게 초대를 보냅니다(수락한 사람이 초대를 받아들여야 멤버가 됨, 자동 멤버십 없음).
 *
 * 런타임 의존성 없음.
 */
import {
  type CommunityViewer,
  type MembershipFacts,
  type NameMode,
  type SpaceFacts,
  NAME_MODES,
  canReadSpace,
  canWriteBoard,
  checkSpaceName,
  hasSchoolAffiliation,
  SPACE_NAME_MAX,
} from './community'

export const RECRUITMENT_KINDS = ['team', 'study'] as const
export type RecruitmentKind = (typeof RECRUITMENT_KINDS)[number]
export const RECRUITMENT_STATUSES = ['open', 'closed', 'cancelled'] as const
export type RecruitmentStatus = (typeof RECRUITMENT_STATUSES)[number]
export const APPLICATION_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn'] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export const RECRUITMENT_TITLE_MAX = 80
export const RECRUITMENT_DESCRIPTION_MAX = 2000
export const APPLICATION_MESSAGE_MAX = 500
/** 모집 인원(수락할 수 있는 지원자 수, 모집자 제외). */
export const RECRUITMENT_CAPACITY_MIN = 2
export const RECRUITMENT_CAPACITY_MAX = 20
/** 지원서에 붙일 수 있는 공개 사례 링크 수. */
export const APPLICATION_CASES_MAX = 3
/** 마감 예정 시각은 지금부터 90일 안. */
export const RECRUITMENT_CLOSES_AT_MAX_MS = 90 * 24 * 60 * 60 * 1000

/** 사용자별 한도: 모집 글 하루 5개, 지원 하루 20개, 초대 링크 받기 시간당 10번. */
export const RECRUITMENT_CREATE_LIMIT = { limit: 5, windowMs: 24 * 60 * 60 * 1000 } as const
export const APPLICATION_CREATE_LIMIT = { limit: 20, windowMs: 24 * 60 * 60 * 1000 } as const
export const RECRUITMENT_INVITE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const

export const RECRUITMENT_KIND_LABELS: Readonly<Record<RecruitmentKind, string>> = { team: '팀원', study: '스터디' }
export const RECRUITMENT_STATUS_LABELS: Readonly<Record<RecruitmentStatus, string>> = { open: '모집 중', closed: '마감', cancelled: '취소됨' }

/** 거절·마감(선정되지 않음) 때 지원자에게 보이는 유일한 문장. 사유는 어디에도 없습니다. */
export const RECRUITMENT_NOT_SELECTED_TEXT = '모집이 마감되었거나 선정되지 않았습니다.'
export const RECRUITMENT_CANCELLED_TEXT = '모집이 취소되었습니다.'
/** 운영 조치로 가린 모집 글·지원 메시지 자리. */
export const RECRUITMENT_HIDDEN_TEXT = '운영 조치로 가려진 모집 글입니다.'
export const APPLICATION_MESSAGE_HIDDEN_TEXT = '운영 조치로 가려진 메시지입니다.'

/** 지원자 본인에게 보이는 지원 상태 문장. 거절은 마감과 구분하지 않습니다. */
export const APPLICATION_STATUS_TEXT: Readonly<Record<ApplicationStatus, string>> = {
  pending: '검토 중',
  accepted: '선정됨',
  declined: RECRUITMENT_NOT_SELECTED_TEXT,
  withdrawn: '지원을 취소했습니다.',
}

/**
 * 모집자가 보는 지원 DTO의 키 전부(통합 테스트가 정확히 이 키만 있는지 확인). 활동량·포크 수·확인 수·점수·순위·거절 사유 같은 필드는 없습니다.
 */
export const RECRUITER_APPLICATION_KEYS = ['id', 'applicant', 'message', 'messageHidden', 'attachments', 'status', 'createdAt', 'decidedAt'] as const

// ── 입력 ─────────────────────────────────────────────────────────────────

export type RecruitmentTextCheck = { ok: true; value: string } | { ok: false; reason: 'required' | 'too_long' | 'invalid' }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** 제목: NFC·공백 하나로·앞뒤 공백 제거, 1~80자, 제어 문자 없음. */
export function checkRecruitmentTitle(raw: unknown): RecruitmentTextCheck {
  if (typeof raw !== 'string') return { ok: false, reason: raw === undefined || raw === null ? 'required' : 'invalid' }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!value) return { ok: false, reason: 'required' }
  if ([...value].length > RECRUITMENT_TITLE_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

/** 소개·지원 메시지: NFC·줄바꿈 정리·앞뒤 공백 제거, 0~max자(비어도 됨), 탭·줄바꿈 외 제어 문자 없음. */
export function checkOptionalText(raw: unknown, max: number): RecruitmentTextCheck {
  if (raw === undefined || raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string' || CONTROL.test(raw)) return { ok: false, reason: 'invalid' }
  const value = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if ([...value].length > max) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

export type CapacityInputCheck = { ok: true; value: number } | { ok: false; reason: 'required' | 'invalid' | 'too_small' | 'too_large' }

export function checkRecruitmentCapacity(raw: unknown): CapacityInputCheck {
  if (raw === undefined || raw === null) return { ok: false, reason: 'required' }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, reason: 'invalid' }
  if (raw < RECRUITMENT_CAPACITY_MIN) return { ok: false, reason: 'too_small' }
  if (raw > RECRUITMENT_CAPACITY_MAX) return { ok: false, reason: 'too_large' }
  return { ok: true, value: raw }
}

/** 마감 예정 시각: 없으면 null, 있으면 지금 이후 90일 안. */
export function checkClosesAt(raw: unknown, now: Date): { ok: true; value: Date | null } | { ok: false; reason: 'invalid' | 'past' | 'too_far' } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) return { ok: false, reason: 'invalid' }
  const at = new Date(raw)
  if (at.getTime() <= now.getTime()) return { ok: false, reason: 'past' }
  if (at.getTime() - now.getTime() > RECRUITMENT_CLOSES_AT_MAX_MS) return { ok: false, reason: 'too_far' }
  return { ok: true, value: at }
}

/** 스터디 방 이름 표시 방식(스터디 모집만): 표시명 기본, 실명·익명도 고를 수 있음(§8.9.5). 팀원 찾기는 null. */
export function roomNameModeFor(kind: RecruitmentKind, raw: unknown): { ok: true; value: NameMode | null } | { ok: false; reason: 'invalid' | 'not_allowed' } {
  if (kind === 'team') return raw === undefined || raw === null ? { ok: true, value: null } : { ok: false, reason: 'not_allowed' }
  if (raw === undefined || raw === null) return { ok: true, value: 'display' }
  return (NAME_MODES as readonly unknown[]).includes(raw) ? { ok: true, value: raw as NameMode } : { ok: false, reason: 'invalid' }
}

/**
 * 마감 때 만들 스터디 방 이름: 모집 제목의 앞 40자(공간 이름 규칙·예약어 검사를 통과해야 함). 모집을 만들 때 미리 확인합니다
 * (마감할 때 이름 때문에 실패하지 않게).
 */
export function studyRoomNameFor(title: string): { ok: true; value: string } | { ok: false; reason: 'required' | 'too_long' | 'invalid' | 'reserved' } {
  const cut = [...title].slice(0, SPACE_NAME_MAX).join('').trim()
  return checkSpaceName(cut, { reserved: true })
}

// ── 권한 ─────────────────────────────────────────────────────────────────

/** 모집이 걸린 곳의 판정 재료. 공간에 올렸으면 host, 과목만이면 courseSchoolId(정본). 둘 다 있으면 공간 읽기가 기준입니다. */
export interface RecruitmentHostFacts {
  host: { space: SpaceFacts; membership: MembershipFacts | null } | null
  /** 과목의 정본 학교(과목이 있을 때). */
  courseSchoolId: string | null
}

export interface RecruitmentFacts extends RecruitmentHostFacts {
  kind: RecruitmentKind
  createdBy: string
  status: RecruitmentStatus
  closesAt: Date | null
  /** 운영 조치로 가림(hide_recruitment). */
  hidden: boolean
  /** 과목 큐레이터(지금은 운영자)가 팀 배정 과목으로 표시해 팀원 찾기를 숨김(`courses.team_finding_disabled`). */
  teamFindingDisabled: boolean
}

const isActiveViewer = (v: CommunityViewer | null | undefined): v is CommunityViewer => !!v && v.status === 'active'

/** 모집이 걸린 곳을 읽을 수 있는지(공간 읽기 정책 또는 과목 학교 인증). */
export function canReadRecruitmentHost(viewer: CommunityViewer | null | undefined, facts: RecruitmentHostFacts): boolean {
  if (!isActiveViewer(viewer)) return false
  if (facts.host) return canReadSpace(viewer, facts.host.space, facts.host.membership)
  return hasSchoolAffiliation(viewer, facts.courseSchoolId)
}

/**
 * 모집 글을 볼 수 있는지. 아니면 404(존재를 숨김).
 * - 걸린 곳을 읽을 수 있어야 합니다(모집자 본인도 — 학교 인증이 해제되면 자기 모집도 404, C-05와 같음).
 * - 운영 조치로 가렸거나, 팀 배정 과목으로 팀원 찾기가 꺼진 과목의 팀원 모집은 모집자 본인만 봅니다(취소할 수 있게).
 */
export function canViewRecruitment(viewer: CommunityViewer | null | undefined, r: RecruitmentFacts): boolean {
  if (!canReadRecruitmentHost(viewer, r)) return false
  const mine = viewer!.userId === r.createdBy
  if (r.hidden && !mine) return false
  if (r.kind === 'team' && r.teamFindingDisabled && !mine) return false
  return true
}

export type PostDecision =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'write_restricted' | 'affiliation_required' | 'no_recruiting_board' | 'write_not_allowed' | 'team_finding_disabled' | 'course_required' | 'host_required' }

/**
 * 모집 글을 올릴 수 있는지(C-07).
 * - 공간에 올리면: 그 공간을 읽을 수 있어야 하고(아니면 not_found), 모집(recruiting) 게시판이 있어야 하며, 그 게시판에 쓸 자격(canWriteBoard:
 *   active 공간·학교/학과 인증·멤버·학과 쓰기 제한 없음·이용 제한 없음)이 있어야 합니다.
 * - 과목을 고르면 그 과목 학교(정본)의 active 인증이 있어야 합니다(공간에 올려도). 과목만이면 그것이 읽기 자격이기도 합니다.
 * - 팀원 찾기는 과목이 필수이고, 팀 배정 과목(팀원 찾기 꺼짐)에는 올릴 수 없습니다.
 * - 이용 제한(C-06)은 viewer.communityWriteSuspended(그 공간 범위 포함, 공간이 없으면 커뮤니티 전체만)로 막습니다.
 */
export function canPostRecruitment(
  viewer: CommunityViewer | null | undefined,
  input: RecruitmentHostFacts & {
    kind: RecruitmentKind
    hasCourse: boolean
    teamFindingDisabled: boolean
    recruitingBoard: { kind: 'recruiting'; writeRole: 'member' | 'moderator' } | null
  },
): PostDecision {
  if (!isActiveViewer(viewer)) return { ok: false, reason: 'not_found' }
  if (!input.host && !input.hasCourse) return { ok: false, reason: 'host_required' }
  if (input.kind === 'team' && !input.hasCourse) return { ok: false, reason: 'course_required' }
  if (input.host && !canReadSpace(viewer, input.host.space, input.host.membership)) return { ok: false, reason: 'not_found' }
  if (input.hasCourse && !hasSchoolAffiliation(viewer, input.courseSchoolId)) return { ok: false, reason: 'affiliation_required' }
  if (viewer.communityWriteSuspended) return { ok: false, reason: 'write_restricted' }
  if (input.kind === 'team' && input.teamFindingDisabled) return { ok: false, reason: 'team_finding_disabled' }
  if (input.host) {
    if (!input.recruitingBoard) return { ok: false, reason: 'no_recruiting_board' }
    if (!canWriteBoard(viewer, input.host.space, input.host.membership, input.recruitingBoard)) return { ok: false, reason: 'write_not_allowed' }
  }
  return { ok: true }
}

export type ApplyDecision = { ok: true } | { ok: false; reason: 'not_found' | 'own_recruitment' | 'recruitment_not_open' | 'write_restricted' | 'already_applied' }

/** 지원할 수 있는지. 볼 수 없으면 not_found. 자기 모집·마감(또는 마감 예정 시각이 지남)·이미 지원·이용 제한이면 거절. */
export function canApply(
  viewer: CommunityViewer | null | undefined,
  r: RecruitmentFacts,
  existing: { status: ApplicationStatus } | null,
  now: Date,
): ApplyDecision {
  if (!canViewRecruitment(viewer, r) || r.hidden) return { ok: false, reason: 'not_found' }
  if (viewer!.userId === r.createdBy) return { ok: false, reason: 'own_recruitment' }
  if (!isRecruitmentAccepting(r, now)) return { ok: false, reason: 'recruitment_not_open' }
  if (existing) return { ok: false, reason: 'already_applied' }
  if (viewer!.communityWriteSuspended) return { ok: false, reason: 'write_restricted' }
  return { ok: true }
}

/** 지금 지원을 받는지: 모집 중이고 마감 예정 시각이 지나지 않았음. */
export function isRecruitmentAccepting(r: { status: RecruitmentStatus; closesAt: Date | null }, now: Date): boolean {
  return r.status === 'open' && (!r.closesAt || r.closesAt.getTime() > now.getTime())
}

// ── 상태 전이 ────────────────────────────────────────────────────────────

export type ApplicationEvent = 'accept' | 'decline' | 'withdraw'

/**
 * 지원 상태 전이. 허용되지 않으면 null.
 * - accept: pending → accepted(모집자, 정원 확인은 canAcceptMore).
 * - decline: pending·accepted → declined(모집자, 마감 전). 사유 없음.
 * - withdraw: pending·accepted → withdrawn(지원자, 마감 전).
 */
export function applicationTransition(status: ApplicationStatus, event: ApplicationEvent): ApplicationStatus | null {
  switch (event) {
    case 'accept':
      return status === 'pending' ? 'accepted' : null
    case 'decline':
      return status === 'pending' || status === 'accepted' ? 'declined' : null
    case 'withdraw':
      return status === 'pending' || status === 'accepted' ? 'withdrawn' : null
  }
}

/** 한 명 더 수락할 수 있는지(모집 인원까지). */
export function canAcceptMore(acceptedCount: number, capacity: number): boolean {
  return acceptedCount < capacity
}

export type RecruitmentEvent = 'close' | 'cancel'

/** 모집 상태 전이. 마감은 모집 중 + 수락한 사람이 한 명 이상, 취소는 모집 중일 때만. */
export function recruitmentTransition(
  status: RecruitmentStatus,
  event: RecruitmentEvent,
  acceptedCount: number,
): { ok: true; status: RecruitmentStatus } | { ok: false; reason: 'recruitment_not_open' | 'no_accepted' } {
  if (status !== 'open') return { ok: false, reason: 'recruitment_not_open' }
  if (event === 'close') return acceptedCount > 0 ? { ok: true, status: 'closed' } : { ok: false, reason: 'no_accepted' }
  return { ok: true, status: 'cancelled' }
}

/** 마감 결과(분석 outcome): 팀원 찾기 → 과제 공간, 스터디 → 스터디 방, 취소. */
export function recruitmentOutcome(kind: RecruitmentKind, status: RecruitmentStatus): 'project' | 'study_room' | 'cancelled' | null {
  if (status === 'cancelled') return 'cancelled'
  if (status === 'closed') return kind === 'team' ? 'project' : 'study_room'
  return null
}

/**
 * 지원 목록 순서: **지원 시각 순서만**(같으면 id). 활동량·포크 수·확인 수·점수로 정렬하지 않습니다(§8.8).
 * 입력 배열을 바꾸지 않고 새 배열을 돌려줍니다.
 */
export function orderApplications<T extends { id: string; createdAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ── 알림 ─────────────────────────────────────────────────────────────────

export const RECRUITMENT_NOTICE_KINDS = ['recruitment_invited', 'recruitment_not_selected', 'recruitment_cancelled'] as const
export type RecruitmentNoticeKind = (typeof RECRUITMENT_NOTICE_KINDS)[number]

export interface RecruitmentNoticePayload {
  /** 모집 종류(팀원/스터디). 제목·모집자·이유는 넣지 않습니다. */
  recruitmentKind: RecruitmentKind
}

/** 모집 알림 payload 허용 목록: 종류만. 다른 키·틀린 값이면 null. */
export function sanitizeRecruitmentNoticePayload(raw: Readonly<Record<string, unknown>>): RecruitmentNoticePayload | null {
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'recruitmentKind') return null
  const kind = raw.recruitmentKind
  if (!(RECRUITMENT_KINDS as readonly unknown[]).includes(kind)) return null
  return { recruitmentKind: kind as RecruitmentKind }
}

export function recruitmentNoticeText(kind: RecruitmentNoticeKind, payload: RecruitmentNoticePayload): string {
  switch (kind) {
    case 'recruitment_invited':
      return payload.recruitmentKind === 'team'
        ? '선정되었습니다. 팀 과제 공간 초대를 받을 수 있습니다. 초대를 수락해야 팀원이 됩니다.'
        : '선정되었습니다. 스터디 방 초대를 받을 수 있습니다. 초대를 수락해야 멤버가 됩니다.'
    case 'recruitment_not_selected':
      return RECRUITMENT_NOT_SELECTED_TEXT
    case 'recruitment_cancelled':
      return RECRUITMENT_CANCELLED_TEXT
  }
}
