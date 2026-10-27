/**
 * 페르소나·handle·표시명 ↔ 실명 연결 (S-01, PROOFU_EVOLUTION_PLAN §4.4·§10.7, SYSTEM_DESIGN §6.7.1 Persona·IdentityLink·§8.3,
 * DELIVERY_PLAN §4.2 S-01·§5.2 R, ADR 0028).
 *
 * - 2~3단계 정체성(표시명·실명)은 페르소나로 저장합니다. P1은 계정당 `real` 하나·`display` 하나까지이고, handle은 두 종류가 같은 전역 공간에서
 *   유일합니다(DB unique). 0~1단계(익명)는 페르소나를 만들지 않습니다.
 * - handle 규칙(`checkHandle`)은 T-02 프로필 handle 규칙 그대로입니다: 3~30자, 소문자·숫자·하이픈(앞뒤·연속 하이픈 없음), 예약어 거부.
 * - **연결 보기(`canSeeIdentityLink`)**: 연결 플래그가 켜져 있을 때만 누구나, 꺼져 있으면 본인만. 공개 경로(공개 프로필 JSON·HTML·OG·
 *   인쇄 보기·README 카드)는 쿠키를 읽지 않으므로 항상 "본인 아님"으로 부르고, 결과가 false면 상대 페르소나의 handle·이름·id·소개를 하나도
 *   싣지 않습니다. 이후 팔로우 목록·추천·피드(S-03~S-05)도 같은 함수를 거칩니다.
 *
 * 런타임 의존성 없음.
 */

export const PERSONA_KINDS = ['real', 'display'] as const
export type PersonaKind = (typeof PERSONA_KINDS)[number]

export const PERSONA_KIND_LABELS: Readonly<Record<PersonaKind, string>> = {
  real: '실명 프로필',
  display: '표시명 프로필',
}

export const HANDLE_MIN = 3
export const HANDLE_MAX = 30
/** 표시명 페르소나 이름 최대 길이(계정 표시 이름과 같은 50자). */
export const PERSONA_DISPLAY_NAME_MAX = 50

/** URL 경로·운영 용어와 겹치는 handle. 두 종류 페르소나에 똑같이 적용합니다. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'app', 'assets', 'auth', 'courses',
  'edit', 'health', 'help', 'invitations', 'invite', 'login', 'logout', 'me', 'new', 'null', 'onboarding',
  'peerchive', 'profile', 'profiles', 'project', 'projects', 'proofu', 'root', 'schools', 'search',
  'settings', 'signup', 'static', 'support', 'system', 'u', 'undefined', 'user', 'users', 'www',
])

/** 소문자·숫자 덩어리를 하이픈 하나로 잇는 형식(앞뒤·연속 하이픈 없음). 길이는 따로 봅니다. */
export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type HandleCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'invalid' | 'too_short' | 'too_long' | 'invalid_format' | 'reserved' }

/** handle 입력을 정규화(앞뒤 공백 제거·소문자)하고 검사합니다. 422 필드 코드와 같은 이유를 돌려줍니다. */
export function checkHandle(raw: unknown): HandleCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' }
  const value = raw.trim().toLowerCase()
  if (value.length < HANDLE_MIN) return { ok: false, reason: 'too_short' }
  if (value.length > HANDLE_MAX) return { ok: false, reason: 'too_long' }
  if (!HANDLE_PATTERN.test(value)) return { ok: false, reason: 'invalid_format' }
  if (RESERVED_HANDLES.has(value)) return { ok: false, reason: 'reserved' }
  return { ok: true, value }
}

/** 경로의 handle이 조회해 볼 만한 모양인지(아니면 DB를 보지 않고 404). 예약어는 여기서 거르지 않습니다(예전 handle 호환). */
export function isLookupHandle(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= HANDLE_MAX && HANDLE_PATTERN.test(raw)
}

export interface IdentityLinkFacts {
  /** IdentityLink.visible. 연결 행이 없으면(표시명 페르소나가 없음) false로 넘깁니다. */
  visible: boolean
}

export interface IdentityLinkViewer {
  /** 보는 사람이 두 페르소나의 주인인지. 공개 경로(쿠키 없음)는 항상 false. */
  isOwner: boolean
}

/**
 * 표시명 ↔ 실명 연결을 보여도 되는지(§8.3 "표시명 ↔ 실명 연결 보기": `IdentityLink.visible`일 때만, 본인은 가능).
 * 운영자의 신고 처리 중 확인(감사 기록과 함께)은 S-07에서 별도 경로로 둡니다 — 이 함수는 운영자에게 예외를 주지 않습니다.
 */
export function canSeeIdentityLink(link: IdentityLinkFacts | null, viewer: IdentityLinkViewer): boolean {
  if (viewer.isOwner) return true
  return link?.visible === true
}

/** 같은 사용자의 다른 페르소나 종류. */
export function otherPersonaKind(kind: PersonaKind): PersonaKind {
  return kind === 'real' ? 'display' : 'real'
}
