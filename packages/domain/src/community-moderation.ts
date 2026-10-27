/**
 * 커뮤니티 신고 누적 임시 숨김·방 운영진 가리기·제재 요청·이용 제한(제재)·운영자 작성자 확인 규칙
 * (C-06, PROOFU_EVOLUTION_PLAN §8.9.4 "방장 권한"·§8.9.6 "신고와 임시 숨김"·"이용 제한"·§15, SYSTEM_DESIGN §6.7 CommunitySanction·
 * "Report 확장"·§8.1, DELIVERY_PLAN §4.1 C-06·§5.1 M, ADR 0023).
 *
 * - **임시 숨김(auto_hidden)**: 같은 글·댓글에 대한 **처리 전(open·in_review) 신고**의 신고자 중, 작성자 본인이 아니고 지금 **active 학교 인증**이
 *   있는(학교 연결 공간은 그 학교, 연결 안 한 방은 아무 학교) **서로 다른 사람**의 수가 기준(공식 페이지 5, 사용자·스터디 방 3)에 이르면 숨깁니다.
 *   같은 사람의 여러 신고(신고자·대상마다 한 번만 받음)·작성자 자신·인증이 해제된 사람·다른 학교 사람은 세지 않습니다.
 * - **이용 제한(제재)**: 경고(warning, 알림만) → 쓰기 기간 제한(write_suspended, until까지) → 영구 제한(permanent, 커뮤니티 전체).
 *   범위는 커뮤니티 전체(community) 또는 공간 하나(space). 커뮤니티 쓰기(글·댓글·공감·방 만들기)만 막고 과제 공간·포트폴리오·공개 프로필·
 *   과목 허브 읽기에는 영향이 없습니다(이 판정은 커뮤니티 정책 함수에서만 씀).
 * - **작성자 확인(canResolveAuthor)**: 운영자만. 사유가 필수이고, 확인할 때마다 기록(조회 기록 + 감사 id만)이 남습니다.
 *
 * 런타임 의존성 없음.
 */
import { type SpaceKind, isOfficialKind } from './community'

// ── 임시 숨김 ────────────────────────────────────────────────────────────

/** 서로 다른 인증 신고자 기준 수(초기안: 공식 페이지 5, 사용자 방 3). 환경 변수로 바꿀 수 있습니다(웹 설정). */
export const AUTO_HIDE_THRESHOLDS = { official: 5, room: 3 } as const
export const AUTO_HIDE_THRESHOLD_MIN = 2
export const AUTO_HIDE_THRESHOLD_MAX = 50

export interface AutoHideThresholds {
  official: number
  room: number
}

/** 공간 종류의 기준 수. */
export function autoHideThreshold(kind: SpaceKind, thresholds: AutoHideThresholds = AUTO_HIDE_THRESHOLDS): number {
  return isOfficialKind(kind) ? thresholds.official : thresholds.room
}

/** 환경 변수 값 → 기준 수(정수 2~50). 비었거나 틀리면 기본값. */
export function parseAutoHideThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < AUTO_HIDE_THRESHOLD_MIN || n > AUTO_HIDE_THRESHOLD_MAX) return fallback
  return n
}

export interface ThresholdReport {
  reporterId: string
  status: 'open' | 'in_review' | 'resolved' | 'dismissed'
}

/**
 * 기준 수에 셀 신고자 수: 처리 전 신고의 서로 다른 신고자 중 작성자가 아니고 `eligible`(지금 그 공간 기준의 active 학교 인증)에 든 사람.
 */
export function qualifyingReporterCount(reports: readonly ThresholdReport[], authorId: string, eligible: ReadonlySet<string>): number {
  const counted = new Set<string>()
  for (const r of reports) {
    if (r.status !== 'open' && r.status !== 'in_review') continue
    if (r.reporterId === authorId || !eligible.has(r.reporterId)) continue
    counted.add(r.reporterId)
  }
  return counted.size
}

/** 지금 게시 중이고 기준 수에 이르렀으면 auto_hidden으로 바꿉니다(이미 숨김·지움이면 그대로). */
export function shouldAutoHide(input: { status: string; qualifying: number; threshold: number }): boolean {
  return input.status === 'published' && input.qualifying >= input.threshold
}

// ── 제재(CommunitySanction) ──────────────────────────────────────────────

export const SANCTION_LEVELS = ['warning', 'write_suspended', 'permanent'] as const
export type SanctionLevel = (typeof SANCTION_LEVELS)[number]
export const SANCTION_SCOPES = ['community', 'space'] as const
export type SanctionScope = (typeof SANCTION_SCOPES)[number]

/** 쓰기 기간 제한의 최장 기간(이보다 길면 영구 제한으로). */
export const SANCTION_MAX_DAYS = 365
export const SANCTION_LEVEL_LABELS: Readonly<Record<SanctionLevel, string>> = {
  warning: '경고',
  write_suspended: '쓰기 기간 제한',
  permanent: '커뮤니티 영구 제한',
}
export const SANCTION_SCOPE_LABELS: Readonly<Record<SanctionScope, string>> = { community: '커뮤니티 전체', space: '이 공간' }

export interface SanctionFacts {
  scope: SanctionScope
  spaceId: string | null
  level: SanctionLevel
  until: Date | null
  revokedAt: Date | null
}

export type SanctionInputCheck =
  | { ok: true; until: Date | null }
  | { ok: false; field: 'until' | 'scope'; reason: 'required' | 'not_allowed' | 'in_past' | 'too_long' | 'community_only' }

/**
 * 제재 입력 검사: 경고는 기한 없음(알림만), 쓰기 기간 제한은 지금보다 뒤이고 365일 이내인 기한 필수, 영구 제한은 기한 없이 커뮤니티 전체만.
 */
export function checkSanctionInput(input: { level: SanctionLevel; scope: SanctionScope; until: Date | null }, now: Date): SanctionInputCheck {
  if (input.level === 'permanent') {
    if (input.scope !== 'community') return { ok: false, field: 'scope', reason: 'community_only' }
    if (input.until) return { ok: false, field: 'until', reason: 'not_allowed' }
    return { ok: true, until: null }
  }
  if (input.level === 'warning') {
    if (input.until) return { ok: false, field: 'until', reason: 'not_allowed' }
    return { ok: true, until: null }
  }
  if (!input.until) return { ok: false, field: 'until', reason: 'required' }
  if (input.until.getTime() <= now.getTime()) return { ok: false, field: 'until', reason: 'in_past' }
  if (input.until.getTime() - now.getTime() > SANCTION_MAX_DAYS * 24 * 60 * 60 * 1000) return { ok: false, field: 'until', reason: 'too_long' }
  return { ok: true, until: input.until }
}

/** 지금 효력이 있는 제재인지(되돌리지 않았고, 기간 제한이면 기한 전). 경고도 "효력"은 있지만 쓰기를 막지 않습니다. */
export function isSanctionActive(s: Pick<SanctionFacts, 'level' | 'until' | 'revokedAt'>, now: Date): boolean {
  if (s.revokedAt) return false
  if (s.level === 'write_suspended') return !!s.until && s.until.getTime() > now.getTime()
  return true
}

/** 이 제재가 이 공간(null이면 공간 밖: 방 만들기 등)의 커뮤니티 쓰기를 막는지. 경고는 막지 않습니다. */
export function sanctionBlocksWrite(s: SanctionFacts, spaceId: string | null, now: Date): boolean {
  if (s.level === 'warning' || !isSanctionActive(s, now)) return false
  if (s.scope === 'community') return true
  return spaceId !== null && s.spaceId === spaceId
}

export interface WriteRestriction {
  level: Exclude<SanctionLevel, 'warning'>
  scope: SanctionScope
  /** 기간 제한이면 가장 늦은 기한, 영구면 null. */
  until: Date | null
}

/**
 * 이 공간에서 쓰기를 막는 제재들을 하나로: 영구가 있으면 영구, 아니면 가장 늦게 끝나는 기간 제한(범위는 커뮤니티 전체가 우선).
 * 막는 제재가 없으면 null.
 */
export function activeWriteRestriction(sanctions: readonly SanctionFacts[], spaceId: string | null, now: Date): WriteRestriction | null {
  const blocking = sanctions.filter((s) => sanctionBlocksWrite(s, spaceId, now))
  if (blocking.length === 0) return null
  const permanent = blocking.find((s) => s.level === 'permanent')
  if (permanent) return { level: 'permanent', scope: 'community', until: null }
  const latest = [...blocking].sort((a, b) => b.until!.getTime() - a.until!.getTime())[0]!
  const scope: SanctionScope = blocking.some((s) => s.scope === 'community') ? 'community' : 'space'
  return { level: 'write_suspended', scope, until: latest.until }
}

/** 쓰기 제한 안내(글쓰기 화면·오류). 누가 요청했는지·어느 글 때문인지는 싣지 않습니다. */
export function writeRestrictionText(r: WriteRestriction): string {
  const where = r.scope === 'community' ? '커뮤니티 전체에서' : '이 공간에서'
  if (r.level === 'permanent') return `이용 제한으로 ${where} 글·댓글·공감을 쓸 수 없습니다. 내 알림에서 사유를 확인하고 이의를 제기할 수 있습니다.`
  return `이용 제한으로 ${where} 기한까지 글·댓글·공감을 쓸 수 없습니다. 내 알림에서 사유를 확인하고 이의를 제기할 수 있습니다.`
}

// ── 제재 요청(방장·모더레이터) ───────────────────────────────────────────

export const SANCTION_REQUEST_STATUSES = ['open', 'resolved', 'dismissed'] as const
export type SanctionRequestStatus = (typeof SANCTION_REQUEST_STATUSES)[number]
export const SANCTION_REQUEST_DETAILS_MAX = 1000
/** 방 운영진 한 사람의 제재 요청 한도: 시간당 10, 하루 30. */
export const SANCTION_REQUEST_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const
export const SANCTION_REQUEST_DAILY_LIMIT = { limit: 30, windowMs: 24 * 60 * 60 * 1000 } as const

// ── 방 운영진 가리기(space_hide) ─────────────────────────────────────────

export const SPACE_HIDE_NOTE_DEFAULT = '방 운영진이 가림'
/** 방 운영진 한 사람의 가리기 한도: 시간당 30. */
export const SPACE_HIDE_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 } as const

// ── 작성자 확인 ──────────────────────────────────────────────────────────

export const AUTHOR_LOOKUP_REASON_MAX = 1000
/** 운영자 한 사람의 작성자 확인 한도: 시간당 20, 하루 60. */
export const AUTHOR_LOOKUP_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 } as const
export const AUTHOR_LOOKUP_DAILY_LIMIT = { limit: 60, windowMs: 24 * 60 * 60 * 1000 } as const
/** 제재는 이 시간 안에 같은 운영자가 한 작성자 확인으로만 발급합니다. */
export const AUTHOR_LOOKUP_VALID_MS = 24 * 60 * 60 * 1000

/**
 * 익명 글·댓글의 작성자를 확인할 수 있는지(SYSTEM_DESIGN §8.1 `canResolveAuthor`): active 운영자만. 방장·모더레이터·멤버는 불가.
 * 사유 기록·감사는 호출자(서버)가 같은 트랜잭션에서 남깁니다.
 */
export function canResolveAuthor(viewer: { status: 'active' | 'suspended' | 'deleted'; operator: boolean } | null | undefined): boolean {
  return !!viewer && viewer.status === 'active' && viewer.operator
}

// ── 알림(작성자에게) ─────────────────────────────────────────────────────

export const ITEM_REVIEW_NOTICE_KINDS = ['item_auto_hidden', 'item_restored'] as const
export type ItemReviewNoticeKind = (typeof ITEM_REVIEW_NOTICE_KINDS)[number]

export interface ItemReviewNoticePayload {
  target: 'post' | 'comment'
}

/** 임시 숨김·복원 알림 payload 허용 목록: 대상 종류만(신고자·신고 수·사유 없음). */
export function sanitizeItemReviewPayload(raw: Readonly<Record<string, unknown>>): ItemReviewNoticePayload | null {
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'target') return null
  return raw.target === 'post' || raw.target === 'comment' ? { target: raw.target } : null
}

export function itemReviewNoticeText(kind: ItemReviewNoticeKind, payload: ItemReviewNoticePayload): string {
  const what = payload.target === 'post' ? '글' : '댓글'
  return kind === 'item_auto_hidden'
    ? `내 ${what}이 여러 사람의 신고로 운영 검토 중이라 임시로 가려졌습니다. 검토가 끝나면 결과를 알려 드립니다.`
    : `검토 결과 내 ${what}이 다시 보이게 되었습니다.`
}
