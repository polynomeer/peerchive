/**
 * 빌드 로그 화면 도우미: 태그 표시, 입력 폼 ↔ API 요청 변환, 임시 저장(localStorage), 재전송 식별자.
 * 상태는 색이 아니라 텍스트(이모지 + 이름)로 보여 줍니다(시나리오 H).
 */
import type {
  DecisionPayload,
  LogDto,
  LogLinkDto,
  LogTag,
  MeetingPayload,
  SolutionPayload,
  StuckPayload,
  TimeBucket,
  ValidationPayload,
} from '~~/shared/types/api'

export const LOG_TAG_ORDER: LogTag[] = ['progress', 'stuck', 'solution', 'decision', 'meeting', 'validation', 'retro']

export const LOG_TAG_LABELS: Record<LogTag, string> = {
  progress: '🔨 진행',
  stuck: '🧱 막힘',
  solution: '💡 해결',
  decision: '⚖️ 결정',
  meeting: '🗣️ 회의',
  validation: '✅ 검증',
  retro: '🔁 회고',
}

export const TIME_BUCKET_LABELS: Record<TimeBucket, string> = {
  lt30m: '30분 미만',
  lt2h: '2시간 미만',
  half_day: '반나절',
  day_plus: '하루 이상',
}

/** 입력 폼. 목록 필드는 줄바꿈(키워드는 쉼표)으로 나눈 문자열로 받습니다. */
export interface LogForm {
  tag: LogTag
  body: string
  /** 한 줄에 하나: `URL 제목(선택)` */
  links: string
  claimedDate: string
  resolvesEntryId: string
  symptom: string
  keywords: string
  errorText: string
  attempts: string
  timeBucket: TimeBucket | ''
  answerCheck: boolean
  method: string
  notAnswerConfirmed: boolean
  options: string
  criteria: string
  choice: string
  hindsight: string
  target: string
  conditions: string
  result: string
  openQuestions: string
  attendees: string[]
  decisions: string
  followUps: string
  /** 파일 근거(산출물 버전 id, 최대 10개). */
  evidenceVersionIds: string[]
  /** 속한 마일스톤 id(T-06). 빈 문자열이면 없음. */
  milestoneId: string
}

export function emptyLogForm(tag: LogTag = 'progress'): LogForm {
  return {
    tag,
    body: '',
    links: '',
    claimedDate: '',
    resolvesEntryId: '',
    symptom: '',
    keywords: '',
    errorText: '',
    attempts: '',
    timeBucket: '',
    answerCheck: false,
    method: '',
    notAnswerConfirmed: false,
    options: '',
    criteria: '',
    choice: '',
    hindsight: '',
    target: '',
    conditions: '',
    result: '',
    openQuestions: '',
    attendees: [],
    decisions: '',
    followUps: '',
    evidenceVersionIds: [],
    milestoneId: '',
  }
}

const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
const commaList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
const optional = (value: string) => (value.trim() ? value.trim() : undefined)

export function parseLinks(value: string): LogLinkDto[] {
  return lines(value).map((line) => {
    const [url = '', ...rest] = line.split(/\s+/)
    return { url, title: rest.join(' ') || null }
  })
}

export function formatLinks(links: LogLinkDto[]): string {
  return links.map((link) => (link.title ? `${link.url} ${link.title}` : link.url)).join('\n')
}

/** 태그에 해당하는 구조화 필드만 payload로 만듭니다(서버는 모르는 키를 거부). */
export function formPayload(form: LogForm): Record<string, unknown> {
  switch (form.tag) {
    case 'stuck':
      return {
        symptom: form.symptom,
        keywords: commaList(form.keywords),
        errorText: optional(form.errorText),
        attempts: lines(form.attempts),
        timeBucket: form.timeBucket || undefined,
        answerCheck: form.answerCheck,
      }
    case 'solution':
      return { method: form.method, timeBucket: form.timeBucket || undefined, notAnswerConfirmed: form.notAnswerConfirmed }
    case 'decision':
      return { options: lines(form.options), criteria: form.criteria, choice: form.choice, hindsight: optional(form.hindsight) }
    case 'validation':
      return {
        target: form.target,
        conditions: form.conditions,
        result: form.result,
        openQuestions: optional(form.openQuestions),
      }
    case 'meeting':
      return { attendees: form.attendees, decisions: lines(form.decisions), followUps: lines(form.followUps) }
    default:
      return {}
  }
}

/** 작성·수정 요청 본문(공통 부분). */
export function formRequest(form: LogForm) {
  return {
    body: form.body,
    payload: formPayload(form),
    links: parseLinks(form.links),
    claimedDate: form.claimedDate || null,
    evidenceVersionIds: form.evidenceVersionIds,
    milestoneId: form.milestoneId || null,
    ...(form.tag === 'solution' && { resolvesEntryId: form.resolvesEntryId || null }),
  }
}

/** 기존 로그를 수정 폼으로. */
export function logToForm(log: LogDto): LogForm {
  const form = emptyLogForm(log.tag)
  form.body = log.body
  form.links = formatLinks(log.links)
  form.claimedDate = log.claimedDate ?? ''
  form.resolvesEntryId = log.resolves?.id ?? ''
  form.evidenceVersionIds = log.evidence.map((e) => e.versionId)
  form.milestoneId = log.milestone?.id ?? ''
  const p = log.payload
  if (log.tag === 'stuck') {
    const s = p as StuckPayload
    Object.assign(form, {
      symptom: s.symptom,
      keywords: s.keywords.join(', '),
      errorText: s.errorText ?? '',
      attempts: s.attempts.join('\n'),
      timeBucket: s.timeBucket,
      answerCheck: s.answerCheck,
    })
  } else if (log.tag === 'solution') {
    const s = p as SolutionPayload
    Object.assign(form, { method: s.method, timeBucket: s.timeBucket ?? '', notAnswerConfirmed: s.notAnswerConfirmed })
  } else if (log.tag === 'decision') {
    const d = p as DecisionPayload
    Object.assign(form, { options: d.options.join('\n'), criteria: d.criteria, choice: d.choice, hindsight: d.hindsight ?? '' })
  } else if (log.tag === 'validation') {
    const v = p as ValidationPayload
    Object.assign(form, { target: v.target, conditions: v.conditions, result: v.result, openQuestions: v.openQuestions ?? '' })
  } else if (log.tag === 'meeting') {
    const m = p as MeetingPayload
    Object.assign(form, { attendees: [...m.attendees], decisions: m.decisions.join('\n'), followUps: m.followUps.join('\n') })
  }
  return form
}

/** 서버 필드 오류 키(`payload.symptom`, `links.0.url`)를 폼 필드 이름으로. */
export function formFieldErrors(fields: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, code] of Object.entries(fields)) {
    const name = key.startsWith('payload.')
      ? key.split('.')[1]!
      : key.startsWith('links')
        ? 'links'
        : key.startsWith('evidenceVersionIds')
          ? 'evidenceVersionIds'
          : key
    result[name] ??= code
  }
  return result
}

// ── 임시 저장 ──────────────────────────────────────────────────────────────

/** 저장에 실패하거나 새로고침해도 입력이 남도록 프로젝트별로 둡니다. 성공하면 지웁니다. */
export interface LogDraft {
  form: LogForm
  /** 같은 내용을 다시 보낼 때 중복 생성을 막는 식별자. 성공 전까지 유지합니다. */
  clientId: string
}

const draftKey = (projectId: string) => `peerchive:log-draft:${projectId}`

export function loadLogDraft(projectId: string): LogDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(projectId))
    if (!raw) return null
    const draft = JSON.parse(raw) as Partial<LogDraft>
    if (!draft.form || typeof draft.clientId !== 'string') return null
    return { form: { ...emptyLogForm(), ...draft.form }, clientId: draft.clientId }
  } catch {
    return null
  }
}

export function saveLogDraft(projectId: string, draft: LogDraft): void {
  try {
    localStorage.setItem(draftKey(projectId), JSON.stringify(draft))
  } catch {
    // 저장 공간이 없거나 막혀 있으면 화면의 입력만 유지합니다.
  }
}

export function clearLogDraft(projectId: string): void {
  try {
    localStorage.removeItem(draftKey(projectId))
  } catch {
    // 무시
  }
}

/** 폼에 입력한 내용이 있는지(태그·마일스톤만 고른 상태는 빈 폼으로 봄). */
export function isLogFormEmpty(form: LogForm): boolean {
  return JSON.stringify(form) === JSON.stringify({ ...emptyLogForm(form.tag), milestoneId: form.milestoneId })
}

/** UUID v4. crypto.randomUUID가 없는 환경(비보안 origin)도 지원합니다. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })

const PAYLOAD_LABELS: Record<string, string> = {
  symptom: '증상',
  keywords: '키워드',
  errorText: '오류 메시지',
  attempts: '시도한 것',
  timeBucket: '걸린 시간',
  answerCheck: '답 아님 확인',
  method: '해결 방법',
  notAnswerConfirmed: '답 아님 확인',
  options: '선택지',
  criteria: '판단 기준',
  choice: '선택',
  hindsight: '지나고 보니',
  target: '대상',
  conditions: '조건',
  result: '결과',
  openQuestions: '남은 불확실성',
  attendees: '참석자 수',
  decisions: '결정',
  followUps: '후속 할 일',
}

/** 수정 이력에서 이전 revision의 구조화 필드를 한 줄씩 보여 줍니다. */
export function payloadLines(payload: object): string[] {
  // 빈 목록은 건너뜁니다.
  const entries = Object.entries(payload).filter(([, value]) => !(Array.isArray(value) && value.length === 0))
  return entries.map(([key, value]) => {
    const label = PAYLOAD_LABELS[key] ?? key
    if (key === 'attendees' && Array.isArray(value)) return `${label}: ${value.length}`
    if (key === 'timeBucket' && typeof value === 'string') return `${label}: ${TIME_BUCKET_LABELS[value as TimeBucket] ?? value}`
    if (typeof value === 'boolean') return `${label}: ${value ? '예' : '아니오'}`
    if (Array.isArray(value)) return `${label}: ${value.join(' / ')}`
    return `${label}: ${String(value)}`
  })
}
