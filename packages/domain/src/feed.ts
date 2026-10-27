/**
 * 프로필 글·활동 목록·팔로우 피드·팔로우 추천 (S-05, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 ProfilePost·PersonaActivity·§8.3·§11.3,
 * DELIVERY_PLAN §4.2 S-05·§5.2 Q·S·T, ADR 0035).
 *
 * - **읽을 수 있는 항목 종류**(`canViewActivityKind`): 프로필 글·커뮤니티 글은 `posts`, 선배 노트·스터디 기록은 `notes_and_studies` 공개 범위를
 *   따릅니다(`canViewPersonaItem`). 공개 사례(`cases`)는 공개 범위 설정의 대상이 아니라 공개 절차를 거친 것만 나오고(§8.3 불변조건 2),
 *   비공개 계정이면 프로필 목록에서는 승인된 팔로워·본인에게만 보입니다(§8.3 표 "공개 사례 목록: 비공개 계정이면 불가").
 * - **피드 순서**(`compareFeedItems`): "피드는 기록(사례·노트·스터디) 우선"(DELIVERY_PLAN §4.2)을 하루(한국 시간) 단위로 적용합니다 — 최근 날 먼저,
 *   같은 날 안에서는 기록이 글보다 먼저, 그다음 최근 순, 마지막으로 활동 id. 날을 넘어 글을 영원히 기록 뒤로 미루지 않으면서 같은 날의 기록을 위로
 *   올립니다. **팔로워 수·공감 수·활동량은 입력에 없습니다**(인기 정렬 없음, §6.7.1 "추천").
 * - **추천 점수**(`suggestionScore`): 같은 과목·같은 학교·관심 직무의 교집합 개수만 셉니다. 동점은 보는 사람마다 고정된 무작위 키(`tieKey`)로
 *   가릅니다(팔로워 수·handle 알파벳 순서 같은 편향 없음).
 *
 * 런타임 의존성 없음.
 */
import type { PersonaActivityItemKind } from './persona-activities'
import { type PersonaFacts, type PersonaViewer, type VisibilityAudience, canViewPersona, canViewPersonaItem } from './visibility'

// ── 프로필 글 ─────────────────────────────────────────────────────────────

export const PROFILE_POST_STATUSES = ['published', 'deleted', 'hidden'] as const
export type ProfilePostStatus = (typeof PROFILE_POST_STATUSES)[number]

/** 프로필 글 본문 최대 길이(글자 수, DB check와 같음). */
export const PROFILE_POST_MAX = 500

/** 프로필 글 작성 한도(사용자당). 짧은 글 도배를 막습니다. */
export const PROFILE_POST_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 } as const

export type ProfilePostBodyResult = { ok: true; body: string } | { ok: false; reason: 'required' | 'too_long' }

/** 본문 정규화: 줄바꿈을 \n으로, 앞뒤 공백 제거, 연속 빈 줄은 둘까지. 비면 required, 500자(코드 포인트)를 넘으면 too_long. */
export function normalizeProfilePostBody(raw: unknown): ProfilePostBodyResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'required' }
  const body = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (body.length === 0) return { ok: false, reason: 'required' }
  if ([...body].length > PROFILE_POST_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, body }
}

// ── 항목 종류별 열람 ──────────────────────────────────────────────────────

export const ACTIVITY_KINDS = ['cases', 'notes_and_studies', 'posts'] as const satisfies readonly PersonaActivityItemKind[]

export function isActivityKind(value: unknown): value is PersonaActivityItemKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value)
}

/**
 * 이 페르소나의 이 종류 활동을 볼 수 있는지. `stored`는 그 항목의 저장된 공개 범위(cases는 쓰지 않음).
 * 차단당했거나 비활성 페르소나면 언제나 false(`canViewPersona`).
 */
export function canViewActivityKind(
  persona: PersonaFacts,
  kind: PersonaActivityItemKind,
  stored: VisibilityAudience | null | undefined,
  viewer: PersonaViewer,
): boolean {
  if (!canViewPersona(persona, viewer)) return false
  if (kind === 'cases') return viewer.isOwner || persona.accountPrivacy === 'public' || viewer.approvedFollower
  return canViewPersonaItem(persona, kind, stored, viewer)
}

// ── 피드 순서 ─────────────────────────────────────────────────────────────

/** 한국 시간(UTC+9) 기준 날 번호. SQL `floor((extract(epoch from created_at) + 32400) / 86400)`과 같은 값입니다. */
export function feedDay(at: Date): number {
  return Math.floor((at.getTime() / 1000 + 9 * 3600) / 86400)
}

/** 같은 날 안의 묶음: 기록(공개 사례·선배 노트·스터디 기록) 0, 글(프로필 글·커뮤니티 글) 1. */
export function feedBucket(kind: PersonaActivityItemKind): 0 | 1 {
  return kind === 'posts' ? 1 : 0
}

export interface FeedRankKey {
  day: number
  bucket: 0 | 1
  /** 활동 시각(ms). */
  at: number
  id: string
}

export function feedRankKey(item: { itemKind: PersonaActivityItemKind; createdAt: Date; id: string }): FeedRankKey {
  return { day: feedDay(item.createdAt), bucket: feedBucket(item.itemKind), at: item.createdAt.getTime(), id: item.id }
}

/** 피드 순서 비교(앞이 먼저면 음수): 최근 날 → 기록 먼저 → 최근 시각 → id 내림차순. */
export function compareFeedKeys(a: FeedRankKey, b: FeedRankKey): number {
  if (a.day !== b.day) return b.day - a.day
  if (a.bucket !== b.bucket) return a.bucket - b.bucket
  if (a.at !== b.at) return b.at - a.at
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export function compareFeedItems(
  a: { itemKind: PersonaActivityItemKind; createdAt: Date; id: string },
  b: { itemKind: PersonaActivityItemKind; createdAt: Date; id: string },
): number {
  return compareFeedKeys(feedRankKey(a), feedRankKey(b))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 피드 cursor(마지막 항목의 순서 키) → 문자열. 순서 키만 담습니다(누구의 활동인지 없음). */
export function encodeFeedCursor(key: FeedRankKey): string {
  return `${key.day}.${key.bucket}.${key.at}.${key.id}`
}

/** 형식이 틀리면 null(→ 422). */
export function decodeFeedCursor(raw: unknown): FeedRankKey | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^(\d{1,7})\.([01])\.(\d{1,15})\.([0-9a-f-]{36})$/)
  if (!m || !UUID.test(m[4]!)) return null
  return { day: Number(m[1]), bucket: Number(m[2]) as 0 | 1, at: Number(m[3]), id: m[4]! }
}

/** 활동 목록(한 페르소나) cursor: 최근 순이라 시각·id만. */
export function encodeActivityCursor(item: { createdAt: Date; id: string }): string {
  return `${item.createdAt.getTime()}.${item.id}`
}

export function decodeActivityCursor(raw: unknown): { at: number; id: string } | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^(\d{1,15})\.([0-9a-f-]{36})$/)
  if (!m || !UUID.test(m[2]!)) return null
  return { at: Number(m[1]), id: m[2]! }
}

export const FEED_PAGE_SIZE = 20

// ── 팔로우 추천 ───────────────────────────────────────────────────────────

export const SUGGESTION_LIMIT = 10

export type SuggestionReason = 'course' | 'institution' | 'job_target'

export const SUGGESTION_REASON_LABELS: Readonly<Record<SuggestionReason, string>> = {
  course: '같은 과목',
  institution: '같은 학교',
  job_target: '같은 관심 직무',
}

export interface SuggestionSignals {
  /** 보는 사람의 과목과 겹치는, 보는 사람이 볼 수 있는 상대의 과제 수행 목록 과목 수. */
  sharedCourses: number
  /** 두 사람 모두 같은 정본 학교의 active 인증이 있고, 상대가 학교 배지를 공개함(실명 페르소나만). */
  sameInstitution: boolean
  /** 공개 프로필의 관심 직무 교집합 수. */
  sharedJobTargets: number
}

/** 교집합 개수만으로 매긴 점수. 0이면 추천하지 않습니다. 팔로워 수·활동량은 입력에 없습니다. */
export function suggestionScore(s: SuggestionSignals): number {
  return 3 * Math.min(s.sharedCourses, 3) + (s.sameInstitution ? 2 : 0) + Math.min(s.sharedJobTargets, 3)
}

export function suggestionReasons(s: SuggestionSignals): SuggestionReason[] {
  const out: SuggestionReason[] = []
  if (s.sharedCourses > 0) out.push('course')
  if (s.sameInstitution) out.push('institution')
  if (s.sharedJobTargets > 0) out.push('job_target')
  return out
}

export interface SuggestionCandidate {
  personaId: string
  /** 페르소나 주인(한 사람의 두 페르소나를 함께 추천하지 않음). */
  ownerKey: string
  signals: SuggestionSignals
  /** 보는 사람마다 고정된 무작위 동점 키(예: hash(보는 사람, 페르소나)). */
  tieKey: string
}

/**
 * 추천 순서: 점수 내림차순 → tieKey. 점수 0은 뺍니다. 한 사람(ownerKey)의 페르소나는 하나만(점수가 높은 쪽, 같으면 tieKey가 앞인 쪽) —
 * 두 프로필을 나란히 추천하면 같은 사람임을 짐작할 수 있습니다.
 */
export function rankSuggestions<T extends SuggestionCandidate>(candidates: readonly T[], limit = SUGGESTION_LIMIT): T[] {
  const sorted = candidates
    .filter((c) => suggestionScore(c.signals) > 0)
    .sort((a, b) => suggestionScore(b.signals) - suggestionScore(a.signals) || (a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0))
  const seen = new Set<string>()
  const out: T[] = []
  for (const c of sorted) {
    if (seen.has(c.ownerKey)) continue
    seen.add(c.ownerKey)
    out.push(c)
    if (out.length >= limit) break
  }
  return out
}
