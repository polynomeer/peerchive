/**
 * 소셜 링크·되돌림 링크 확인 (S-06, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 SocialLink·§10, DELIVERY_PLAN §4.2 S-06·§5.2 V, ADR 0034).
 *
 * - 링크는 **페르소나마다 따로**입니다. 한 링크는 한 페르소나에만 속하고, 같은 사용자의 다른 페르소나에 같은 주소를 걸 수 없습니다(두 프로필이
 *   같은 외부 계정으로 이어지면 연결 플래그와 무관하게 같은 사람임이 드러나므로).
 * - 주소 규칙(`parseSocialLinkUrl`): https만, 기본 포트(443)만, 사용자 정보(아이디·비밀번호) 없음, IP 주소 host 없음(10진·8진·16진 표기도
 *   WHATWG URL이 IPv4로 바꾸므로 함께 거부), localhost·`.local`·`.internal` 같은 내부 이름 없음, 길이 300자. 알려진 서비스(GitHub·Instagram·
 *   YouTube·LinkedIn)는 그 서비스의 주소여야 합니다(다른 사이트에 GitHub 배지가 붙지 않게).
 * - **`확인됨`은 "그 페이지에 이 Peerchive 프로필로 돌아오는 링크가 있다"는 뜻일 뿐**입니다. 인물·경력·소속을 검증하지 않습니다(문구로도 밝힘).
 *   확인은 worker의 링크 수집기만 합니다(웹 서버는 사용자가 붙인 URL에 접속하지 않음, §10).
 * - 상태 전이(`nextSocialLinkState`): 되돌림 링크가 있으면 verified, 없으면 verified였던 링크는 lost(확인 요청이 아닌 재확인에서도),
 *   가져오기 실패는 상태를 두고 연속 실패만 세며 verified 링크가 `SOCIAL_LINK_MAX_FAILURES`번 연속 실패하면 lost.
 *
 * 런타임 의존성 없음(WHATWG `URL`만 씀).
 */

export const SOCIAL_LINK_PROVIDERS = ['github', 'blog', 'linkedin', 'instagram', 'youtube', 'other'] as const
export type SocialLinkProvider = (typeof SOCIAL_LINK_PROVIDERS)[number]

export const SOCIAL_LINK_PROVIDER_LABELS: Readonly<Record<SocialLinkProvider, string>> = {
  github: 'GitHub',
  blog: '블로그',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  youtube: 'YouTube',
  other: '기타',
}

export const SOCIAL_LINK_VERIFICATIONS = ['unverified', 'verified', 'lost'] as const
export type SocialLinkVerification = (typeof SOCIAL_LINK_VERIFICATIONS)[number]

/** 마지막 확인 결과(본인 화면에만). blocked는 주소가 내부망을 가리키는 등 수집기 규칙으로 접속하지 않은 경우입니다. */
export const SOCIAL_LINK_CHECK_RESULTS = ['found', 'missing', 'fetch_failed', 'blocked'] as const
export type SocialLinkCheckResult = (typeof SOCIAL_LINK_CHECK_RESULTS)[number]

/** 페르소나당 링크 수. */
export const SOCIAL_LINK_LIMIT = 8
/** 주소 길이(입력 그대로 기준). */
export const SOCIAL_LINK_URL_MAX = 300
/** verified 링크가 이만큼 연속으로 가져오기에 실패하면 lost. 재확인은 링크마다 하루 한 번이므로 대략 사흘. */
export const SOCIAL_LINK_MAX_FAILURES = 3
/** 확인 요청 한도: 사용자당(모든 링크 합) 시간당 20건, 링크당 시간당 3건. 수집기가 남의 사이트를 두드리는 데 쓰이지 않게 합니다. */
export const SOCIAL_LINK_VERIFY_USER_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 } as const
export const SOCIAL_LINK_VERIFY_LINK_RATE_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 } as const
/** 링크 추가 한도(사용자당). 지우고 다시 넣기로 확인 한도를 돌아가지 못하게 합니다. */
export const SOCIAL_LINK_CREATE_RATE_LIMIT = { limit: 30, windowMs: 24 * 60 * 60 * 1000 } as const
/** 재확인 간격: verified 링크를 마지막 확인에서 이만큼 지난 뒤에 다시 봅니다. */
export const SOCIAL_LINK_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export const SOCIAL_LINK_VERIFIED_LABEL = '링크 확인됨'
/** 배지 설명. "인증"으로 읽히지 않게 무엇을 확인했고 무엇을 확인하지 않았는지 함께 씁니다. */
export const SOCIAL_LINK_VERIFIED_NOTE = '이 계정에 Peerchive 프로필 링크가 있음을 확인했을 뿐, 인물·경력을 검증하지 않습니다'

export const SOCIAL_LINK_VERIFICATION_LABELS: Readonly<Record<SocialLinkVerification, string>> = {
  unverified: '확인 전',
  verified: SOCIAL_LINK_VERIFIED_LABEL,
  lost: '확인 끊김',
}

export const SOCIAL_LINK_CHECK_RESULT_TEXT: Readonly<Record<SocialLinkCheckResult, string>> = {
  found: '페이지에서 이 프로필 링크를 찾았습니다.',
  missing: '페이지에서 이 프로필 링크를 찾지 못했습니다.',
  fetch_failed: '페이지를 가져오지 못했습니다(응답 없음·오류·HTML이 아님·너무 큼). 잠시 뒤 다시 시도하세요.',
  blocked: '이 주소는 내부망을 가리키거나 허용하지 않는 곳으로 이동해 확인하지 않았습니다.',
}

/** 알려진 서비스의 host(그 host 또는 하위 도메인). blog·other는 아무 공개 host. */
const PROVIDER_HOSTS: Readonly<Partial<Record<SocialLinkProvider, readonly string[]>>> = {
  github: ['github.com'],
  instagram: ['instagram.com'],
  youtube: ['youtube.com', 'youtu.be'],
  linkedin: ['linkedin.com'],
}

/** 공개 인터넷 이름이 아닌 접미사(마지막 이름 또는 마지막 두 이름). */
const INTERNAL_SUFFIXES: ReadonlySet<string> = new Set([
  'localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'localdomain', 'test', 'example', 'invalid', 'onion', 'arpa',
  'home.arpa',
])

/** 마지막 이름(TLD)은 글자로 시작하거나 IDN(`xn--`)입니다. 숫자뿐인 TLD는 WHATWG가 IPv4로 읽는 이름입니다. */
const TLD = /^(?:[a-z][a-z0-9-]*[a-z0-9]|xn--[a-z0-9-]+)$/
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

export type SocialLinkUrlReason = 'too_long' | 'invalid' | 'scheme' | 'credentials' | 'port' | 'ip_literal' | 'host' | 'provider_mismatch'

/**
 * host가 공개 인터넷 이름인지(IP 주소·내부 이름이 아님). 이름만 보며 DNS는 보지 않습니다 — 해석한 주소는 수집기가 접속할 때마다 따로 검사합니다.
 * `hostname`은 WHATWG URL의 hostname(소문자, IPv4 표기 정규화됨)입니다.
 */
export function checkPublicHostname(hostname: string): 'ok' | 'ip_literal' | 'host' {
  if (!hostname || hostname.length > 253) return 'host'
  if (hostname.startsWith('[') || hostname.includes(':')) return 'ip_literal'
  if (/^[0-9.]+$/.test(hostname)) return 'ip_literal'
  if (hostname.endsWith('.')) return 'host'
  const labels = hostname.split('.')
  if (labels.length < 2) return 'host'
  const tld = labels.at(-1)!
  if (/^[0-9]+$/.test(tld)) return 'ip_literal'
  if (!TLD.test(tld) || !labels.every((l) => LABEL.test(l))) return 'host'
  if (INTERNAL_SUFFIXES.has(tld) || INTERNAL_SUFFIXES.has(labels.slice(-2).join('.'))) return 'host'
  return 'ok'
}

const hostMatches = (hostname: string, domain: string) => hostname === domain || hostname.endsWith(`.${domain}`)

export type SocialLinkUrlCheck = { ok: true; url: string; hostname: string } | { ok: false; reason: SocialLinkUrlReason }

/**
 * 소셜 링크 주소 검사·정규화. 통과하면 fragment(`#…`)를 뺀 WHATWG href를 돌려줍니다(저장·중복 판단은 이 값).
 * provider를 주면 알려진 서비스의 host인지도 봅니다.
 */
export function parseSocialLinkUrl(raw: unknown, provider?: SocialLinkProvider): SocialLinkUrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' }
  const input = raw.trim()
  if (input.length === 0) return { ok: false, reason: 'invalid' }
  if (input.length > SOCIAL_LINK_URL_MAX) return { ok: false, reason: 'too_long' }
  // URL 파서는 탭·줄바꿈을 조용히 지우고 앞뒤 제어 문자를 자릅니다. 그런 입력은 처음부터 받지 않습니다.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(input)) return { ok: false, reason: 'invalid' }
  if (!/^https:\/\//i.test(input)) return /^[a-z][a-z0-9+.-]*:/i.test(input) ? { ok: false, reason: 'scheme' } : { ok: false, reason: 'invalid' }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (url.username || url.password || /^https:\/\/[^/?#]*@/i.test(input)) return { ok: false, reason: 'credentials' }
  if (url.port !== '') return { ok: false, reason: 'port' }
  const host = checkPublicHostname(url.hostname)
  if (host !== 'ok') return { ok: false, reason: host }
  const domains = provider ? PROVIDER_HOSTS[provider] : undefined
  if (domains && !domains.some((d) => hostMatches(url.hostname, d))) return { ok: false, reason: 'provider_mismatch' }
  url.hash = ''
  const href = url.href
  if (href.length > SOCIAL_LINK_URL_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, url: href, hostname: url.hostname }
}

/** 페르소나의 공개 프로필 주소(되돌림 링크가 가리켜야 하는 곳). origin은 사이트 첫 origin(NUXT_SITE_ORIGIN 첫 항목)입니다. */
export function personaProfileUrl(origin: string, handle: string): string {
  return `${origin.replace(/\/+$/, '')}/u/${handle}`
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', sol: '/', colon: ':', period: '.' }

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

const trimSlash = (path: string) => path.replace(/\/+$/, '')

/**
 * HTML에 프로필 주소로 가는 링크(`href`)가 있는지. host(대소문자 무시)와 경로(`/u/<handle>`, 끝의 `/` 무시)가 같으면 됩니다.
 * 스킴(http·https)·query·fragment는 보지 않습니다. 글 본문에 주소를 적기만 한 것은 세지 않습니다(링크여야 함).
 * 외부 링크를 자기 redirect 주소로 감싸는 서비스(예: 일부 SNS)는 찾지 못할 수 있습니다(ADR 0034 열린 질문).
 */
export function pageLinksTo(html: string, pageUrl: string, profileUrl: string): boolean {
  let target: URL
  try {
    target = new URL(profileUrl)
  } catch {
    return false
  }
  const wantHost = target.host.toLowerCase()
  const wantPath = trimSlash(target.pathname).toLowerCase()
  for (const m of html.matchAll(HREF)) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim())
    if (!raw || raw.length > 2048) continue
    let href: URL
    try {
      href = new URL(raw, pageUrl)
    } catch {
      continue
    }
    if (href.protocol !== 'https:' && href.protocol !== 'http:') continue
    if (href.host.toLowerCase() === wantHost && trimSlash(href.pathname).toLowerCase() === wantPath) return true
  }
  return false
}

/** 수집 결과를 상태 전이용으로 줄인 것: 되돌림 링크 있음 / 없음(페이지는 받음, 404·410 포함) / 가져오기 실패·접속 거부. */
export type SocialLinkFetchOutcome = 'found' | 'missing' | 'error'

export interface SocialLinkState {
  verification: SocialLinkVerification
  /** 연속 가져오기 실패 수. */
  failures: number
}

export interface SocialLinkTransition extends SocialLinkState {
  /** 이번에 verified가 되었는지(verified_at을 이번 시각으로). */
  verifiedNow: boolean
}

/**
 * 확인·재확인 한 번의 결과로 다음 상태를 정합니다(확인 요청과 재확인이 같은 규칙).
 * - found → verified(연속 실패 0). 이미 verified면 verified_at은 그대로.
 * - missing → verified였으면 lost, unverified·lost는 그대로(연속 실패 0).
 * - error → 상태는 그대로, 연속 실패 +1. verified가 `SOCIAL_LINK_MAX_FAILURES`번 연속 실패하면 lost.
 */
export function nextSocialLinkState(current: SocialLinkState, outcome: SocialLinkFetchOutcome): SocialLinkTransition {
  if (outcome === 'found') return { verification: 'verified', failures: 0, verifiedNow: current.verification !== 'verified' }
  if (outcome === 'missing') return { verification: current.verification === 'verified' ? 'lost' : current.verification, failures: 0, verifiedNow: false }
  const failures = current.failures + 1
  const lost = current.verification === 'verified' && failures >= SOCIAL_LINK_MAX_FAILURES
  return { verification: lost ? 'lost' : current.verification, failures, verifiedNow: false }
}
