/**
 * 학교 메일 인증·학과 자기 신고 규칙 (C-01, PROOFU_EVOLUTION_PLAN §8.6, SYSTEM_DESIGN §6.7 SchoolAffiliation·§8.1·§9.1, DELIVERY_PLAN §4.1 C-01,
 * ADR 0018).
 *
 * - 메일 도메인: 소문자 ASCII로 정규화합니다(IDN은 WHATWG URL 규칙으로 punycode). 등록된 학교 도메인과 같거나 그 하위 도메인이면 일치입니다
 *   (`yu.ac.kr` → `stu.yu.ac.kr` 허용, `evilyu.ac.kr`·`yu.ac.kr.evil.com` 거부). 공용 접미사(`ac.kr` 등)·웹메일 도메인은 학교 도메인으로 등록할 수 없습니다.
 * - 주소: 로컬 부분은 ASCII만 받고 소문자로 바꿉니다. 중복 확인용 정규 주소는 `+태그`를 뗀 주소입니다(같은 메일함의 별칭으로 여러 계정을 인증하는 것 방지).
 * - 인증 코드: 6자리, 10분, 틀린 시도 5회면 잠김. 해시·상수 시간 비교는 서버(node:crypto)에서 합니다. 여기는 판정 규칙만 둡니다.
 * - 재학/졸업생: 자기 선언. 재학생 → 졸업생만 바꿀 수 있습니다(졸업생은 인증 이력을 그대로 유지).
 * - 학과: 자기 신고, 선택, 40자. 공개하지 않습니다. 학번은 받지 않습니다.
 *
 * 런타임 의존성 없음(전역 URL만 씀). 다른 파일을 import하지 않습니다: 운영 CLI(packages/db/scripts/school-email-domain.ts)가 Node 타입 제거로
 * 이 파일만 직접 불러 같은 도메인 규칙을 씁니다.
 */

/** courses.ts의 normalizeLabel과 같은 규칙(NFC, 공백 하나로, 앞뒤 공백 제거). 이 파일을 단독으로 불러 쓰려고 여기 둡니다. */
const normalizeLabel = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim()

export const INSTITUTION_KINDS = ['university'] as const
export type InstitutionKind = (typeof INSTITUTION_KINDS)[number]
export const AFFILIATION_METHODS = ['email'] as const
export type AffiliationMethod = (typeof AFFILIATION_METHODS)[number]
export const AFFILIATION_STANDINGS = ['student', 'alumni'] as const
export type AffiliationStanding = (typeof AFFILIATION_STANDINGS)[number]
export const AFFILIATION_STATUSES = ['pending', 'active', 'revoked', 'expired'] as const
export type AffiliationStatus = (typeof AFFILIATION_STATUSES)[number]

export const AFFILIATION_STANDING_LABELS: Readonly<Record<AffiliationStanding, string>> = {
  student: '재학생',
  alumni: '졸업생',
}

export const AFFILIATION_CODE_LENGTH = 6
export const AFFILIATION_CODE_TTL_MS = 10 * 60 * 1000
export const AFFILIATION_CODE_MAX_ATTEMPTS = 5
export const DEPARTMENT_LABEL_MAX = 40
export const SCHOOL_EMAIL_MAX = 254

const HOUR_MS = 60 * 60 * 1000

/**
 * 인증 요청 한도(고정 창). perUser·perIp를 넘으면 429, perAddress(정규 주소 HMAC)를 넘으면 응답은 같은 202이고 발송만 하지 않습니다
 * (그 주소가 쓰이는지 드러내지 않음).
 */
export const AFFILIATION_RATE_LIMITS = {
  perUser: { limit: 5, windowMs: HOUR_MS },
  perAddress: { limit: 3, windowMs: HOUR_MS },
  perIp: { limit: 30, windowMs: HOUR_MS },
} as const

// ── 도메인 ───────────────────────────────────────────────────────────────

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * 메일 도메인을 소문자 ASCII로 정규화합니다. 형식이 틀리면 null.
 * 레이블 둘 이상, 각 레이블은 글자·숫자·하이픈(앞뒤 하이픈 없음), 마지막 레이블은 글자 TLD(IP 주소 거부). 끝의 점은 뗍니다.
 */
export function normalizeMailDomain(raw: string): string | null {
  const trimmed = raw.trim().replace(/\.$/, '')
  if (!trimmed || trimmed.length > 253 || /[\s/:@?#\\[\]%*]/.test(trimmed)) return null
  let host: string
  try {
    host = new URL(`http://${trimmed}`).hostname
  } catch {
    return null
  }
  if (!host || host.length > 253) return null
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null
  if (!TLD.test(labels[labels.length - 1]!)) return null
  return host
}

/** 학교 도메인으로 등록할 수 없는 공용 접미사(대학·기관용 2단계 도메인). 이것만으로는 어느 학교인지 알 수 없습니다. */
export const SHARED_MAIL_SUFFIXES: ReadonlySet<string> = new Set([
  'ac.kr', 'co.kr', 'or.kr', 'go.kr', 'ne.kr', 're.kr', 'pe.kr', 'hs.kr', 'ms.kr', 'es.kr', 'sc.kr', 'kg.kr',
  'ac.jp', 'ac.uk', 'ac.nz', 'ac.in', 'ac.cn', 'ac.za',
  'edu.au', 'edu.cn', 'edu.hk', 'edu.sg', 'edu.tw', 'co.uk', 'co.jp', 'com.au', 'com.cn',
])

/** 학교 도메인이 될 수 없는 웹메일 도메인. */
export const WEBMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.kr', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'mail.com',
])

export type SchoolDomainCheck = { ok: true; domain: string } | { ok: false; reason: 'invalid' | 'shared_suffix' | 'webmail' }

/** 운영자가 등록하려는 학교 메일 도메인 검사. TLD 하나·공용 접미사·웹메일은 거부합니다(와일드카드 TLD 없음). */
export function checkSchoolDomain(raw: string): SchoolDomainCheck {
  const domain = normalizeMailDomain(raw)
  if (!domain) return { ok: false, reason: 'invalid' }
  if (SHARED_MAIL_SUFFIXES.has(domain)) return { ok: false, reason: 'shared_suffix' }
  if (WEBMAIL_DOMAINS.has(domain)) return { ok: false, reason: 'webmail' }
  return { ok: true, domain }
}

/** 메일 도메인이 등록된 도메인과 같거나 그 하위 도메인인지. 둘 다 정규화된 값이어야 합니다. */
export function schoolDomainMatches(mailDomain: string, registered: string): boolean {
  return mailDomain === registered || mailDomain.endsWith(`.${registered}`)
}

/** 등록된 도메인 중 가장 구체적인(긴) 일치. 없으면 null. */
export function findMatchingSchoolDomain<T extends { domain: string }>(mailDomain: string, registered: readonly T[]): T | null {
  let best: T | null = null
  for (const row of registered) {
    if (schoolDomainMatches(mailDomain, row.domain) && (!best || row.domain.length > best.domain.length)) best = row
  }
  return best
}

// ── 주소 ─────────────────────────────────────────────────────────────────

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/

export interface ParsedSchoolEmail {
  /** 발송할 주소(로컬 부분 소문자 + ASCII 도메인). */
  address: string
  /** 중복 확인용 정규 주소(`+태그` 제거). 이 값의 HMAC만 저장합니다. */
  canonical: string
  domain: string
}

/** 학교 메일 주소 해석. 형식이 틀리면 null. 로컬 부분은 ASCII만, 점으로 시작·끝나거나 점 두 개 연속이면 거부. */
export function parseSchoolEmail(raw: string): ParsedSchoolEmail | null {
  const value = raw.trim()
  if (!value || value.length > SCHOOL_EMAIL_MAX) return null
  const at = value.lastIndexOf('@')
  if (at <= 0 || value.indexOf('@') !== at) return null
  const local = value.slice(0, at).toLowerCase()
  if (!LOCAL_PART.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null
  const domain = normalizeMailDomain(value.slice(at + 1))
  if (!domain) return null
  const base = local.split('+')[0]!
  if (!base) return null
  return { address: `${local}@${domain}`, canonical: `${base}@${domain}`, domain }
}

// ── 학과·재학 상태 ──────────────────────────────────────────────────────

export type DepartmentLabelCheck = { ok: true; value: string | null } | { ok: false; reason: 'too_long' | 'invalid' }

/** 자기 신고 학과: 공백 정리, 비면 null, 40자 이하. 줄바꿈·제어 문자는 거부합니다. */
export function normalizeDepartmentLabel(raw: unknown): DepartmentLabelCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = normalizeLabel(raw)
  if (!value) return { ok: true, value: null }
  if ([...value].length > DEPARTMENT_LABEL_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

/** 재학생 → 졸업생만 허용(같은 값은 변화 없음). 졸업생 → 재학생은 해제 뒤 다시 인증합니다. */
export function canChangeStanding(from: AffiliationStanding, to: AffiliationStanding): boolean {
  return from === to || (from === 'student' && to === 'alumni')
}

// ── 인증 코드 ────────────────────────────────────────────────────────────

/** 6자리 숫자인지(공백은 앞뒤만 허용). */
export function normalizeAffiliationCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return /^[0-9]{6}$/.test(value) ? value : null
}

export interface CodeState {
  expiresAt: Date
  attempts: number
  usedAt: Date | null
}

export type CodeAttemptDecision =
  | { kind: 'verified' }
  | { kind: 'mismatch'; attempts: number; attemptsLeft: number }
  | { kind: 'locked'; attempts: number }
  | { kind: 'expired' }
  | { kind: 'used' }

/**
 * 코드 한 번 입력의 결과. 이미 쓴 코드·만료·이미 잠긴 코드는 일치 여부를 보지 않습니다(시도 횟수도 늘지 않음).
 * 틀리면 시도 +1, 그 결과 5회에 이르면 locked(소속 행은 expired로).
 */
export function decideCodeAttempt(code: CodeState, matched: boolean, now: Date): CodeAttemptDecision {
  if (code.usedAt) return { kind: 'used' }
  if (code.attempts >= AFFILIATION_CODE_MAX_ATTEMPTS) return { kind: 'locked', attempts: code.attempts }
  if (code.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' }
  if (matched) return { kind: 'verified' }
  const attempts = code.attempts + 1
  if (attempts >= AFFILIATION_CODE_MAX_ATTEMPTS) return { kind: 'locked', attempts }
  return { kind: 'mismatch', attempts, attemptsLeft: AFFILIATION_CODE_MAX_ATTEMPTS - attempts }
}

/** 공개 프로필 배지 글자("○○대학교 인증", 졸업생이면 " · 졸업생"). 학과·도메인은 넣지 않습니다. */
export function affiliationBadgeLabel(schoolName: string, standing: AffiliationStanding): string {
  return standing === 'alumni' ? `${schoolName} 인증 · 졸업생` : `${schoolName} 인증`
}
