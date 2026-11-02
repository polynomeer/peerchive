/**
 * 공개 전 점검 규칙 (T-11, PROOFU_EVOLUTION_PLAN §9.3·§9.4·§15, SYSTEM_DESIGN §7.2 "공개 전 점검").
 *
 * - 결과는 **경고**이며 게시를 막지 않습니다. 판단은 학생이 합니다.
 * - 규칙은 공개될 내용(공개 스냅샷)에만 돌립니다. 비공개 작업 공간 전체를 훑지 않습니다.
 * - 경고에는 위치와 가린 표본(sample)만 남깁니다. 찾은 값 전체(전화번호·주민등록번호 등)를 다시 저장하지 않습니다.
 * - 오탐을 줄이는 장치(guard): 숫자 경계(앞뒤가 숫자·영문이면 무시), 날짜(YYYYMMDD) 제외, 단위가 붙은 수 제외,
 *   예시 도메인 메일 제외, git SSH 주소 제외, 공인 주소 URL 제외, `resolution` 같은 단어 안의 `solution` 제외.
 * AI·경량 모델 점검(타인 실명 등)은 P1입니다. 지금은 익명으로 고른 팀원의 이름이 본문에 남았는지만 봅니다.
 */

export const PUBLICATION_CHECK_RULES = [
  'phone',
  'email',
  'resident_id',
  'student_id',
  'private_url',
  'answer_file',
  'long_code',
  'anonymous_name',
  'pdf_metadata',
  'github_private',
] as const
export type PublicationCheckRule = (typeof PUBLICATION_CHECK_RULES)[number]

/** 점검 대상의 종류: 일반 글, 파일 이름, URL. */
export type CheckItemKind = 'text' | 'file_name' | 'url'

export interface CheckLocation {
  /** 어디에 있는 내용인지. senior_note는 선배 노트(T-13), case_study·portfolio는 케이스 스터디·포트폴리오 판(T-14)입니다. */
  kind: 'title' | 'summary' | 'log' | 'claim' | 'milestone' | 'artifact' | 'senior_note' | 'case_study' | 'portfolio' | 'course_qa' | 'completion_retro'
  /** 스냅샷 안의 키(로그 `l3`, 선언 `c1`, 파일은 버전 id 등). 제목·요약은 없음. */
  key?: string
  /** 필드 경로(예: `body`, `payload.errorText`, `links.0.url`, `displayName`). */
  field: string
}

export interface CheckItem {
  kind: CheckItemKind
  location: CheckLocation
  value: string
}

export interface CheckWarning {
  rule: PublicationCheckRule
  location: CheckLocation
  /** 가린 표본. 원래 값을 복원할 수 없게 일부만 보입니다. */
  sample: string
}

export interface CheckOptions {
  /** 익명으로 고른 팀원의 표시 이름. 공개될 글에 이 이름이 남아 있으면 경고합니다. */
  anonymousNames?: readonly string[]
  /**
   * 공개될 PDF 중 문서 속성(Author·dc:creator)에 작성자 정보가 있는 것. 검사 작업이 저장한 가린 표본만 받습니다
   * (pdfAuthorSample). 파일을 고쳐 쓰지 않으므로 학생이 문서 속성을 지우고 다시 올리도록 경고합니다.
   */
  pdfAuthorMetadata?: ReadonlyArray<{ artifactVersionId: string; sample: string }>
  /**
   * 이 과제에 연결했던(지금·이전) **비공개** GitHub 저장소의 주소(`https://github.com/owner/repo`, E-11 ADR 0056). 공개될 링크·글이 이 저장소를
   * 가리키면 `github_private`로 경고합니다(공개 페이지 방문자는 열 수 없고, 제목이 비공개 저장소의 내용일 수 있음).
   */
  privateRepoUrls?: readonly string[]
}

/** 긴 코드로 보는 줄 수(이상). 과제 답 코드일 수 있어 저장소 링크 + 핵심 발췌를 권합니다(§15 "코드 전문"). */
export const LONG_CODE_LINES = 15

// ── 가리기 ───────────────────────────────────────────────────────────────

/** 앞 2글자·뒤 2글자만 남기고 글자·숫자를 `*`로 가립니다. 짧으면 전부 가립니다. */
export function maskSample(value: string, keepStart = 2, keepEnd = 2): string {
  const chars = [...value]
  if (chars.length <= keepStart + keepEnd + 1) return chars.map((c) => (/[\p{L}\p{N}]/u.test(c) ? '*' : c)).join('')
  return chars
    .map((c, i) => (i < keepStart || i >= chars.length - keepEnd || !/[\p{L}\p{N}]/u.test(c) ? c : '*'))
    .join('')
}

// ── 개별 규칙 ────────────────────────────────────────────────────────────

const MOBILE = /(?<![\p{L}\p{N}])01[016789][-. ]?\d{3,4}[-. ]?\d{4}(?!\d)/gu
const LANDLINE = /(?<![\p{L}\p{N}.])(?:02|0[3-6][1-5])[-. )][ ]?\d{3,4}[-. ]\d{4}(?!\d)/gu

/** 한국 휴대전화·지역번호 전화번호. 지역번호는 구분자가 있을 때만(숫자만 이어진 0으로 시작하는 수와 구분). */
export function findPhoneNumbers(text: string): string[] {
  return [...(text.match(MOBILE) ?? []), ...(text.match(LANDLINE) ?? [])]
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i

/** 메일 주소. 예시 도메인(example.com, .test 등)과 git SSH 주소(`git@github.com:org/repo`)는 뺍니다. */
export function findEmails(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(EMAIL)) {
    const address = match[0]
    const domain = address.slice(address.indexOf('@') + 1)
    if (EXAMPLE_DOMAIN.test(domain)) continue
    if (text[match.index + address.length] === ':') continue
    found.push(address)
  }
  return found
}

const RESIDENT_ID = /(?<![\p{L}\p{N}])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[- ]?[1-8]\d{6}(?!\d)/gu

/** 주민등록번호·외국인등록번호 형태(생년월일 6자리 + 성별 자리 1–8 + 6자리). 월·일이 날짜가 아니면 무시합니다. */
export function findResidentIds(text: string): string[] {
  return text.match(RESIDENT_ID) ?? []
}

const STUDENT_ID = /(?<![\p{L}\p{N}.,])(?:19|20)\d{6,8}(?![\p{L}\p{N}]|[.,]\d)/gu
const UNIT_AFTER = /^\s?(?:bytes?|b|kb|mb|gb|ms|ns|us|px|원|개|명|회|번|건|줄|바이트|초)(?![\p{L}])/iu

function isCalendarDate(digits: string): boolean {
  if (digits.length !== 8) return false
  const y = Number(digits.slice(0, 4))
  const m = Number(digits.slice(4, 6))
  const d = Number(digits.slice(6, 8))
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * 학번처럼 보이는 8–10자리 수(입학 연도 19xx·20xx로 시작). 날짜(YYYYMMDD), 단위가 붙은 수(`20480000 bytes`),
 * 더 긴 수·영숫자(해시) 일부, 소수·천 단위 구분 수는 뺍니다.
 */
export function findStudentIds(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(STUDENT_ID)) {
    const digits = match[0]
    if (isCalendarDate(digits)) continue
    if (UNIT_AFTER.test(text.slice(match.index + digits.length))) continue
    found.push(digits)
  }
  return found
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/gi
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
}

/** URL의 호스트가 사설·로컬 주소인지(공개 페이지에서 열리지 않거나 내부 시스템을 드러냄). 형식이 틀린 URL은 false. */
export function isPrivateUrl(raw: string): boolean {
  let host: string
  try {
    host = new URL(raw).hostname
  } catch {
    return false
  }
  if (!host) return false
  return PRIVATE_SUFFIX.test(host) || isPrivateIpv4(host) || isPrivateIpv6(host)
}

/** 글 안의 URL 중 사설·로컬 주소. 표본은 호스트만. */
export function findPrivateUrls(text: string): string[] {
  return (text.match(URL_IN_TEXT) ?? []).filter(isPrivateUrl)
}

const ANSWER_FILE_KO = /(문제지|정답|답안|해답|기출)/
const ANSWER_FILE_EN = /(?:^|[^a-z])(solutions?|answers?|answer[-_ ]?key)(?:[^a-z]|$)/i

/** 과제 문제지·답안으로 보이는 파일 이름(§15 "과제 원문"). `resolution`·`answering`처럼 단어 안에 든 것은 무시합니다. */
export function looksLikeAnswerFile(fileName: string): boolean {
  return ANSWER_FILE_KO.test(fileName) || ANSWER_FILE_EN.test(fileName)
}

const CODE_LINE = /^(?:\s{2,}|\t)\S|[;{}]\s*$|^\s*(?:def|class|import|from|#include|public|private|static|function|const|let|var|return|for|while|if)\b/

/**
 * 긴 코드 블록(답 코드일 수 있음). ``` 울타리 안의 줄 수, 또는 코드처럼 보이는 줄(들여쓰기·`;{}`로 끝남·키워드 시작)이
 * 연속으로 LONG_CODE_LINES 이상이면 그 줄 수를 돌려줍니다. 없으면 0.
 */
export function longestCodeBlock(text: string): number {
  const lines = text.split(/\r?\n/)
  let longest = 0
  let fenced = -1
  let run = 0
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fenced >= 0) {
        longest = Math.max(longest, fenced)
        fenced = -1
      } else {
        fenced = 0
      }
      run = 0
      continue
    }
    if (fenced >= 0) {
      fenced++
      continue
    }
    run = line.trim() !== '' && CODE_LINE.test(line) ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  // 닫히지 않은 울타리는 끝까지 코드로 봅니다.
  if (fenced >= 0) longest = Math.max(longest, fenced)
  return longest >= LONG_CODE_LINES ? longest : 0
}

/** 익명 팀원 이름이 글에 남았는지(대소문자 무시, 2글자 이상 이름만). */
export function findAnonymousNames(text: string, names: readonly string[]): string[] {
  const lower = text.toLocaleLowerCase('ko-KR')
  return names.filter((name) => {
    const n = name.trim()
    return [...n].length >= 2 && lower.includes(n.toLocaleLowerCase('ko-KR'))
  })
}

/**
 * 글·URL 안에서 비공개 저장소 주소(`https://github.com/owner/repo` 자체 또는 그 아래 경로)를 찾아 `owner/repo`를 돌려줍니다(대소문자 무시, E-11).
 * `owner/repo-other`처럼 이름이 이어지는 다른 저장소는 맞추지 않습니다.
 */
export function findPrivateRepoRefs(text: string, repoUrls: readonly string[]): string[] {
  if (repoUrls.length === 0) return []
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const raw of repoUrls) {
    const base = raw.replace(/\/+$/, '').toLowerCase()
    if (!base.startsWith('https://github.com/')) continue
    let from = 0
    for (;;) {
      const at = lower.indexOf(base, from)
      if (at < 0) break
      const next = lower[at + base.length]
      if (next === undefined || /[\/?#\s)\]>"'.,]/.test(next)) {
        found.push(base.slice('https://github.com/'.length))
        break
      }
      from = at + base.length
    }
  }
  return found
}

// ── 실행 ─────────────────────────────────────────────────────────────────

function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return maskSample(raw)
  }
}

/**
 * 공개될 항목들에 규칙을 돌려 경고 목록을 만듭니다(같은 위치·규칙·표본은 한 번만).
 * - text: 전화·메일·주민등록번호·학번·사설 URL·긴 코드·익명 이름
 * - url: 사설 URL(+ 메일·전화가 URL에 박힌 경우)
 * - file_name: 문제지·답안 이름, 익명 이름, 전화·메일·학번
 * - options.pdfAuthorMetadata: PDF 문서 속성의 작성자 정보(`pdf_metadata`, 위치는 그 파일의 `metadata`)
 * - options.privateRepoUrls: text·url에서 비공개 GitHub 저장소 주소(`github_private`, 표본은 `owner/repo`)
 */
export function runPublicationChecks(items: readonly CheckItem[], options: CheckOptions = {}): CheckWarning[] {
  const warnings: CheckWarning[] = []
  const seen = new Set<string>()
  const push = (rule: PublicationCheckRule, location: CheckLocation, sample: string) => {
    const id = `${rule}|${location.kind}|${location.key ?? ''}|${location.field}|${sample}`
    if (seen.has(id)) return
    seen.add(id)
    warnings.push({ rule, location, sample })
  }
  const anonymousNames = options.anonymousNames ?? []
  const privateRepoUrls = options.privateRepoUrls ?? []

  for (const { kind, location, value } of items) {
    if (!value) continue
    for (const v of findResidentIds(value)) push('resident_id', location, v.replace(/\d/g, '*'))
    for (const v of findPhoneNumbers(value)) push('phone', location, maskSample(v, 3, 2))
    for (const v of findEmails(value)) push('email', location, maskSample(v, 2, 4))
    for (const v of findStudentIds(value)) push('student_id', location, maskSample(v, 2, 0))
    for (const name of findAnonymousNames(value, anonymousNames)) push('anonymous_name', location, maskSample(name, 1, 0))
    if (kind !== 'file_name') for (const repo of findPrivateRepoRefs(value, privateRepoUrls)) push('github_private', location, repo)
    if (kind === 'url') {
      if (isPrivateUrl(value)) push('private_url', location, hostOf(value))
    } else if (kind === 'text') {
      for (const v of findPrivateUrls(value)) push('private_url', location, hostOf(v))
      const lines = longestCodeBlock(value)
      if (lines > 0) push('long_code', location, `${lines}줄`)
    } else if (kind === 'file_name') {
      if (looksLikeAnswerFile(value)) push('answer_file', location, value)
    }
  }
  for (const { artifactVersionId, sample } of options.pdfAuthorMetadata ?? []) {
    push('pdf_metadata', { kind: 'artifact', key: artifactVersionId, field: 'metadata' }, sample)
  }
  return warnings
}
