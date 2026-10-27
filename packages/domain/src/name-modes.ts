/**
 * 커뮤니티 이름 표시 방식·변경 예약·작성 시점 고정 (C-03, PROOFU_EVOLUTION_PLAN §4.4·§8.9.3·§8.9.4, SYSTEM_DESIGN §6.7
 * CommunitySpace.current_name_mode·NameModeChange·Post/Comment.name_mode·"실명", §8.1, DELIVERY_PLAN §4.1 C-03·§5.1 L, ADR 0020).
 *
 * - 공간의 이름 표시 방식(real/display/anonymous)은 공간 행의 `current_name_mode` 하나입니다. 공식 페이지는 anonymous 고정(바꿀 수 없음),
 *   사용자 방·스터디 방은 방장(owner)만 7일 뒤 적용으로 예약합니다(`effective_at = requested_at + 7일`). 한 공간에 예약은 하나만.
 * - **글·댓글은 쓰는 순간의 방식을 복사해 고정합니다(nameModeAtWrite).** 예약된 변경은 effective_at 전에는 아무 영향이 없고, 지난 뒤에는
 *   worker가 적용하기 전이라도 새 방식으로 씁니다(effectiveNameMode). 이미 쓴 글의 방식은 어떤 경우에도 바뀌지 않습니다(소급 0건).
 * - 작성자 표시(resolveAuthorDisplay)는 글에 고정된 방식만 보고 정합니다. 보는 사람이 방장·모더레이터·운영자여도 결과가 같습니다
 *   (§8.1 "방장·모더레이터용 API도 같은 공개 DTO"). 익명 글의 작성자 확인은 C-06의 감사 기록 경로뿐입니다.
 *
 * 런타임 의존성 없음.
 */
import { type JoinPolicy, type NameMode, type SpaceKind, NAME_MODES, NAME_MODE_LABELS, isOfficialKind } from './community'

/** 예약에서 적용까지(7일, §8.9.4 "전환 전 멤버 전원에게 알리고 7일 뒤 적용"). DB check도 같은 값입니다. */
export const NAME_MODE_CHANGE_DELAY_MS = 7 * 24 * 60 * 60 * 1000
export const NAME_MODE_CHANGE_STATUSES = ['scheduled', 'applied', 'cancelled'] as const
export type NameModeChangeStatus = (typeof NAME_MODE_CHANGE_STATUSES)[number]

/** 실명(users.real_name) 최대 길이. 계정에 입력한 선택 값이며 Peerchive가 신분을 확인하지 않습니다(§6.7 "실명"). */
export const REAL_NAME_MAX = 30
/** 실명을 입력하지 않은 사람이 실명 방식 글에 보이는 이름(C-04가 쓰기 전에 실명 입력을 요구하므로 드묾: 실명을 지운 경우). */
export const REAL_NAME_MISSING_LABEL = '실명 미입력'
/** 탈퇴(정리)한 작성자. 실명·표시명 글에서 이름 대신 씁니다. */
export const WITHDRAWN_AUTHOR_LABEL = '탈퇴한 사용자'

export function nameModeEffectiveAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + NAME_MODE_CHANGE_DELAY_MS)
}

export function isNameMode(value: unknown): value is NameMode {
  return typeof value === 'string' && (NAME_MODES as readonly string[]).includes(value)
}

// ── 예약 ─────────────────────────────────────────────────────────────────

export type NameModeTransition = { ok: true } | { ok: false; reason: 'fixed' | 'same_mode' | 'invalid' }

/**
 * 바꿀 수 있는 방식인지. 공식 페이지는 어떤 방식으로도 못 바꿉니다(fixed). 사용자 방·스터디 방은 세 방식 어디로든(같은 방식은 same_mode).
 */
export function checkNameModeTransition(kind: SpaceKind, from: NameMode, to: unknown): NameModeTransition {
  if (isOfficialKind(kind)) return { ok: false, reason: 'fixed' }
  if (!isNameMode(to)) return { ok: false, reason: 'invalid' }
  if (to === from) return { ok: false, reason: 'same_mode' }
  return { ok: true }
}

/**
 * 실명 방으로 바꿀 때의 가입 방식(ADR 0020): 자유 가입(open)이면 예약하는 순간 방장 승인(approval)으로 바꿉니다
 * (§6.7 "real 방의 join_policy 기본값은 approval", 7일 사이에 들어오는 사람도 승인을 거치게). approval·invite는 그대로.
 * 실명이 아닌 방식으로 바꿀 때는 건드리지 않습니다. 기본값을 적용하는 것이므로 방장은 나중에 설정에서 다시 자유 가입으로 바꿀 수 있습니다
 * (만들 때와 같은 자유).
 */
export function joinPolicyForNameModeChange(to: NameMode, current: JoinPolicy): JoinPolicy {
  return to === 'real' && current === 'open' ? 'approval' : current
}

export interface ScheduledChangeFacts {
  status: NameModeChangeStatus
  toMode: NameMode
  effectiveAt: Date
}

/** 예약을 취소할 수 있는지: scheduled이고 effective_at 전이어야 합니다(지난 뒤에는 이미 새 방식으로 글이 쓰였을 수 있음). */
export function canCancelNameModeChange(change: ScheduledChangeFacts, now: Date): 'ok' | 'not_scheduled' | 'already_effective' {
  if (change.status !== 'scheduled') return 'not_scheduled'
  if (now.getTime() >= change.effectiveAt.getTime()) return 'already_effective'
  return 'ok'
}

/** worker가 적용할 때가 됐는지. */
export function isNameModeChangeDue(change: ScheduledChangeFacts, now: Date): boolean {
  return change.status === 'scheduled' && change.effectiveAt.getTime() <= now.getTime()
}

/**
 * 지금 효력이 있는 방식. 공간 행의 current_name_mode + (있으면) 기한이 지난 예약. worker가 늦게 돌아도 effective_at이 지나면 새 방식입니다.
 * 기한 전 예약은 무시합니다(예약은 이후 글에만, 그것도 effective_at부터).
 */
export function effectiveNameMode(current: NameMode, scheduled: ScheduledChangeFacts | null | undefined, now: Date): NameMode {
  return scheduled && isNameModeChangeDue(scheduled, now) ? scheduled.toMode : current
}

/** 화면 안내용 남은 일수(올림, 최소 0). "N일 뒤 이름 표시 방식이 ○○로 바뀝니다." */
export function daysUntil(effectiveAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((effectiveAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
}

/** 배너 문장. 남은 일수는 7을 넘지 않습니다(보는 기기 시계가 서버보다 조금 늦어도 "8일 뒤"가 되지 않게). */
export function nameModeBannerText(toMode: NameMode, effectiveAt: Date, now: Date): string {
  const days = Math.min(daysUntil(effectiveAt, now), NAME_MODE_CHANGE_DELAY_MS / (24 * 60 * 60 * 1000))
  const when = days <= 0 ? '곧' : `${days}일 뒤`
  return `${when} 이름 표시 방식이 ${NAME_MODE_LABELS[toMode]}으로 바뀝니다. 이미 쓴 글은 바뀌지 않습니다.`
}

// ── 작성 시점 고정(C-04 계약) ────────────────────────────────────────────

export interface WriteSpaceFacts {
  kind: SpaceKind
  currentNameMode: NameMode
  /** 이 공간의 scheduled 예약(없으면 null). */
  scheduledChange?: ScheduledChangeFacts | null
}

export type NameModeAtWrite = { ok: true; mode: NameMode } | { ok: false; reason: 'mode_fixed' | 'real_not_allowed' | 'invalid' }

/**
 * 글·댓글을 쓰는 순간 복사해 고정할 방식(C-04가 posts.name_mode·comments.name_mode에 넣는 유일한 값).
 * - 사용자 방·스터디 방: 그 순간의 effectiveNameMode. 글쓴이가 다른 방식을 고를 수 없습니다(requested가 있고 다르면 mode_fixed).
 * - 공식 페이지: anonymous 기본, 글 단위로 display만 고를 수 있음(real은 real_not_allowed, §6.7 Post·§8.1 "글 단위 이름 표시 선택").
 * 예약된 변경은 effective_at 전에는 영향이 없습니다. 같은 트랜잭션에서 공간 행을 잠그고(FOR SHARE) 이 함수를 부른 뒤 insert하세요.
 */
export function nameModeAtWrite(space: WriteSpaceFacts, now: Date, requested?: unknown): NameModeAtWrite {
  if (requested !== undefined && requested !== null && !isNameMode(requested)) return { ok: false, reason: 'invalid' }
  if (isOfficialKind(space.kind)) {
    if (requested === 'real') return { ok: false, reason: 'real_not_allowed' }
    return { ok: true, mode: requested === 'display' ? 'display' : 'anonymous' }
  }
  const mode = effectiveNameMode(space.currentNameMode, space.scheduledChange, now)
  if (requested !== undefined && requested !== null && requested !== mode) return { ok: false, reason: 'mode_fixed' }
  return { ok: true, mode }
}

// ── 작성자 표시(C-04 계약) ───────────────────────────────────────────────

/** 작성자 쪽 재료. 작성 시점이 아니라 읽는 시점의 값(이름을 고치면 실명·표시명 글의 이름도 따라감, 방식은 고정). */
export interface AuthorProfileBits {
  userId: string
  status: 'active' | 'suspended' | 'deleted'
  /** 탈퇴 정리를 마쳤는지(users.purged_at). */
  purged: boolean
  /** 계정 표시 이름(users.display_name). display 방식의 이름. P2 RoomProfile·S-01 Persona가 생기면 그 값으로 바뀝니다(ADR 0020). */
  displayName: string
  /** 실명(users.real_name, 선택). real 방식 글에서만 씁니다. */
  realName: string | null
  /** 학교를 연결한 공간에서 그 학교 active 인증이 있는지(§6.7 "실명" — 이름 옆에 인증 여부만). 학교 무관 공간이면 false. */
  schoolVerified?: boolean
}

export interface AuthorViewer {
  userId: string
}

export type AuthorDisplay =
  /** 실명 방식: 계정의 실명(없으면 REAL_NAME_MISSING_LABEL). schoolVerified는 학교 연결 공간의 인증 여부만. */
  | { kind: 'real'; label: string; realNameMissing: boolean; schoolVerified: boolean; mine: boolean }
  /** 표시명 방식: 계정 표시 이름. */
  | { kind: 'display'; label: string; mine: boolean }
  /**
   * 익명: 이름·id·핸들 없음. 스레드 안 번호(`글쓴이`·`익명1`…)는 C-04가 ThreadAlias로 계산해 이 자리에 넣습니다.
   * mine은 보는 사람이 작성자 본인일 때만 true이며 그 사람의 응답에만 들어갑니다(다른 사람과 연결하는 키가 아님).
   */
  | { kind: 'anonymous'; label: null; threadAlias: 'computed_by_thread'; mine: boolean }
  /** 탈퇴한 작성자의 실명·표시명 글. */
  | { kind: 'withdrawn'; label: string; mine: false }

/**
 * 글에 고정된 방식(modeAtWrite)으로 작성자 표시를 정합니다. 결과에는 작성자 id·핸들·프로필 링크가 없습니다.
 * - 보는 사람의 역할(방장·모더레이터·운영자)은 결과를 바꾸지 않습니다. viewer는 "내 글" 표시(mine)에만 씁니다.
 * - anonymous는 작성자가 탈퇴했어도 똑같이 익명입니다(탈퇴 여부도 드러내지 않음).
 * - 공간의 지금 방식·예약은 인자로 받지 않습니다(소급 금지를 타입으로 막음).
 */
export function resolveAuthorDisplay(modeAtWrite: NameMode, author: AuthorProfileBits, viewer: AuthorViewer | null | undefined): AuthorDisplay {
  const mine = !!viewer && viewer.userId === author.userId
  if (modeAtWrite === 'anonymous') return { kind: 'anonymous', label: null, threadAlias: 'computed_by_thread', mine }
  if (author.purged || author.status === 'deleted') return { kind: 'withdrawn', label: WITHDRAWN_AUTHOR_LABEL, mine: false }
  if (modeAtWrite === 'real') {
    const name = author.realName?.trim() || null
    return { kind: 'real', label: name ?? REAL_NAME_MISSING_LABEL, realNameMissing: !name, schoolVerified: !!author.schoolVerified, mine }
  }
  return { kind: 'display', label: author.displayName, mine }
}

/** 실명 입력 검사(NFC·공백 하나로·길이·제어 문자). 빈 값·null은 지우기. */
export type RealNameCheck = { ok: true; value: string | null } | { ok: false; reason: 'too_long' | 'invalid' }

export function checkRealName(raw: unknown): RealNameCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!value) return { ok: true, value: null }
  if ([...value].length > REAL_NAME_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

// ── 커뮤니티 알림 ────────────────────────────────────────────────────────

/** 커뮤니티 알림 종류(community_notices.kind). 이름 표시 방식 변경 셋(C-03) + 내 글의 새 댓글(C-04, community-posts.ts). */
export const COMMUNITY_NOTICE_KINDS = ['name_mode_scheduled', 'name_mode_cancelled', 'name_mode_applied', 'post_commented', 'item_auto_hidden', 'item_restored'] as const
export type CommunityNoticeKind = (typeof COMMUNITY_NOTICE_KINDS)[number]
export const NAME_MODE_NOTICE_KINDS = ['name_mode_scheduled', 'name_mode_cancelled', 'name_mode_applied'] as const
export type NameModeNoticeKind = (typeof NAME_MODE_NOTICE_KINDS)[number]

export interface NameModeNoticePayload {
  fromMode: NameMode
  toMode: NameMode
  /** ISO 시각. */
  effectiveAt: string
  /** 실명 방으로 바꾸며 자유 가입을 방장 승인으로 바꿨는지(예약 알림에만). */
  joinPolicyAdjusted?: boolean
}

/**
 * 알림 payload 허용 목록: 방식 둘·적용 시각·가입 방식 조정 여부만. 이름·공간 이름·사람 id·자유 글은 넣지 않습니다
 * (공간 이름은 읽을 때 멤버십을 확인하고 붙임). 목록 밖 키나 틀린 값이 있으면 null(넣지 않음).
 */
export function sanitizeNoticePayload(kind: CommunityNoticeKind, raw: Readonly<Record<string, unknown>>): NameModeNoticePayload | null {
  if (!(NAME_MODE_NOTICE_KINDS as readonly string[]).includes(kind)) return null
  const allowed = new Set(['fromMode', 'toMode', 'effectiveAt', ...(kind === 'name_mode_scheduled' ? ['joinPolicyAdjusted'] : [])])
  for (const key of Object.keys(raw)) if (!allowed.has(key) || raw[key] === undefined) return null
  const { fromMode, toMode, effectiveAt, joinPolicyAdjusted } = raw
  if (!isNameMode(fromMode) || !isNameMode(toMode) || fromMode === toMode) return null
  if (typeof effectiveAt !== 'string' || Number.isNaN(Date.parse(effectiveAt)) || new Date(effectiveAt).toISOString() !== effectiveAt) return null
  if (joinPolicyAdjusted !== undefined && typeof joinPolicyAdjusted !== 'boolean') return null
  return { fromMode, toMode, effectiveAt, ...(joinPolicyAdjusted !== undefined && { joinPolicyAdjusted }) }
}

/** 알림 문장(화면). 공간 이름은 호출자가 붙입니다. */
export function noticeText(kind: NameModeNoticeKind, payload: NameModeNoticePayload): string {
  const to = NAME_MODE_LABELS[payload.toMode]
  const from = NAME_MODE_LABELS[payload.fromMode]
  switch (kind) {
    case 'name_mode_scheduled':
      return `이름 표시 방식이 ${from}에서 ${to}으로 바뀔 예정입니다. 이미 쓴 글은 바뀌지 않습니다.${payload.joinPolicyAdjusted ? ' 가입 방식은 방장 승인으로 바뀌었습니다.' : ''}`
    case 'name_mode_cancelled':
      return `이름 표시 방식 변경(${from} → ${to}) 예약이 취소되었습니다. 지금 방식(${from})이 그대로 유지됩니다.`
    case 'name_mode_applied':
      return `이름 표시 방식이 ${to}으로 바뀌었습니다. 이제부터 쓰는 글에만 적용되고, 이전 글은 쓸 때의 방식 그대로입니다.`
  }
}
