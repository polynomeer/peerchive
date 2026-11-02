/**
 * 케이스 스터디 템플릿 초안·출처(인용)·역량 × 근거 매트릭스 규칙 (T-14, PROOFU_EVOLUTION_PLAN §10.2–§10.4·§10.6, SYSTEM_DESIGN §6.5,
 * DELIVERY_PLAN T-14 "모든 문장에 출처, 철회된 사례 자동 차단", ADR 0014).
 *
 * - 이 파일의 함수는 **게시된 release 스냅샷**(웹의 PublicSnapshot과 같은 모양, 필요한 부분만 구조적으로 선언)과 사용자가 쓴 글만 다룹니다.
 *   비공개 작업 테이블을 보지 않습니다. 템플릿 초안은 고정된 한국어 문장 틀에 스냅샷 글을 그대로(안전하게 자른 채) 채우며,
 *   사실·숫자를 만들어 내지 않습니다. 숫자는 스냅샷 항목을 센 값(기록 수·팀원 확인 수)뿐입니다.
 * - `CaseSelf`의 "내가 쓴 로그·올린 파일"은 서버가 release의 비공개 참조(refs)에서 계산해 넘깁니다. 어떤 항목을 고를지에만 쓰고,
 *   글에는 넣지 않습니다(글은 스냅샷 글뿐).
 * - 인용(citation)은 스냅샷 안의 항목을 가리킵니다: `{releaseVersion, kind: summary|log|claim|milestone|artifact, key}`.
 *   `summary`(key `summary`)는 스냅샷의 공개 제목·학생 요약입니다(기획서의 log|claim|milestone|artifact에 더한 것, ADR 0014).
 * - 매트릭스 칸은 근거의 **종류와 개수**만 보여 줍니다. 점수·비율·색 농도는 만들지 않습니다(§10.4).
 */
import type { CheckItem } from './publication-checks'

// ── 직무·구역 ────────────────────────────────────────────────────────────

export const CASE_JOB_TARGETS = ['backend', 'frontend', 'data', 'pm', 'design', 'general'] as const
export type CaseJobTarget = (typeof CASE_JOB_TARGETS)[number]
export const CASE_JOB_TARGET_LABELS: Readonly<Record<CaseJobTarget, string>> = {
  backend: '백엔드',
  frontend: '프론트엔드',
  data: '데이터',
  pm: '기획',
  design: '디자인',
  general: '일반',
}

export const CASE_SECTIONS = ['problem_result', 'my_role', 'decisions', 'stuck_solved', 'validation', 'limits', 'sources'] as const
export type CaseSection = (typeof CASE_SECTIONS)[number]
export const CASE_SECTION_LABELS: Readonly<Record<CaseSection, string>> = {
  problem_result: '문제와 결과',
  my_role: '내 역할',
  decisions: '핵심 결정',
  stuck_solved: '막힘과 해결',
  validation: '검증',
  limits: '한계·회고',
  sources: '원본 링크',
}

/** 출처 없는 "본인 회고" 문장을 둘 수 있는 유일한 구역. */
export const REFLECTION_SECTION: CaseSection = 'limits'
export const REFLECTION_LABEL = '본인 회고'

/** 직무별로 앞에 둘 가운데 구역(문제와 결과·내 역할이 먼저, 한계·회고·원본 링크가 끝). 첫 구역은 항목을 하나 더 고릅니다. */
const EMPHASIS: Readonly<Record<CaseJobTarget, readonly CaseSection[]>> = {
  backend: ['decisions', 'stuck_solved', 'validation'],
  frontend: ['validation', 'decisions', 'stuck_solved'],
  data: ['validation', 'stuck_solved', 'decisions'],
  pm: ['decisions', 'validation', 'stuck_solved'],
  design: ['validation', 'decisions', 'stuck_solved'],
  general: ['decisions', 'stuck_solved', 'validation'],
}

/** 직무별 구역 순서. 저장된 문장은 이 순서로 보여 줍니다. */
export function caseSectionOrder(jobTarget: CaseJobTarget): CaseSection[] {
  return ['problem_result', 'my_role', ...EMPHASIS[jobTarget], 'limits', 'sources']
}

// ── 한도 ─────────────────────────────────────────────────────────────────

export const CASE_TITLE_MAX = 80
export const CASE_SENTENCE_MAX = 500
export const CASE_SECTION_SENTENCE_LIMIT = 12
export const CASE_TOTAL_SENTENCE_LIMIT = 60
export const CASE_CITATION_LIMIT = 12

// ── 인용 ─────────────────────────────────────────────────────────────────

export const CITATION_KINDS = ['summary', 'log', 'claim', 'milestone', 'artifact'] as const
export type CitationKind = (typeof CITATION_KINDS)[number]
export const SUMMARY_CITATION_KEY = 'summary'

export interface CaseCitation {
  /** 고정한 release의 공개 버전(release_no). */
  releaseVersion: number
  kind: CitationKind
  /** 스냅샷 키(로그 `l_…`, 선언 `c_…`, 마일스톤 `ms_…`), 파일은 버전 id, 요약은 `summary`. */
  key: string
}

export type CaseSentenceKind = 'evidence' | 'reflection'

export interface CaseSentenceDraft {
  text: string
  /** reflection은 한계·회고 구역에서만, 출처 없이 둘 수 있는 본인 회고("본인 회고"로 표시). */
  kind: CaseSentenceKind
  citations: CaseCitation[]
  /** AI 다듬기(E-14, ADR 0059) 제안을 받아들여 아직 고치지 않은 문장. 출처가 없으면 "본인 회고"여도 게시를 막습니다. */
  aiGenerated?: boolean
}

export interface CaseSectionDraft {
  key: CaseSection
  sentences: CaseSentenceDraft[]
}

// ── 스냅샷(구조적 타입) ──────────────────────────────────────────────────

export interface CaseSnapshotLog {
  key: string
  tag: string
  author: string | null
  body: string
  payload: Record<string, unknown>
  recordedAt: string
  resolves: string | null
}

export interface CaseSnapshot {
  title: string
  summary: string
  kind: 'individual' | 'team' | 'study'
  members: ReadonlyArray<{ key: string; label: string; anonymous: boolean }>
  milestones: ReadonlyArray<{ key: string; position: number; title: string }>
  logs: ReadonlyArray<CaseSnapshotLog>
  claims: ReadonlyArray<{
    key: string
    member: string
    text: string
    status: 'unconfirmed' | 'confirmed' | 'disputed'
    confirmedCount: number
    disputedCount: number
  }>
  artifacts: ReadonlyArray<{ artifactVersionId: string; displayName: string }>
}

/** 초안을 만드는 사람(스냅샷의 팀원 키 + 서버가 비공개 참조에서 계산한 "내가 쓴 로그·올린 파일"). */
export interface CaseSelf {
  memberKey: string
  ownLogKeys: ReadonlySet<string>
  ownArtifactIds: ReadonlySet<string>
}

export function citationExists(snapshot: CaseSnapshot, citation: Pick<CaseCitation, 'kind' | 'key'>): boolean {
  switch (citation.kind) {
    case 'summary':
      return citation.key === SUMMARY_CITATION_KEY
    case 'log':
      return snapshot.logs.some((l) => l.key === citation.key)
    case 'claim':
      return snapshot.claims.some((c) => c.key === citation.key)
    case 'milestone':
      return snapshot.milestones.some((m) => m.key === citation.key)
    case 'artifact':
      return snapshot.artifacts.some((a) => a.artifactVersionId === citation.key)
    default:
      return false
  }
}

const citationId = (c: Pick<CaseCitation, 'kind' | 'key'>) => `${c.kind}:${c.key}`

// ── 글 다루기 ────────────────────────────────────────────────────────────

/** 공백을 한 칸으로 줄이고, 글자(code point) 기준 max를 넘으면 잘라 "…"를 붙입니다. 글을 바꾸거나 더하지 않습니다. */
export function clipText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : text
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [])

export const LOG_TAG_SHORT_LABELS: Readonly<Record<string, string>> = {
  progress: '진행',
  stuck: '막힘',
  solution: '해결',
  decision: '결정',
  meeting: '회의 정리',
  validation: '검증',
  retro: '회고',
}

export const TIME_BUCKET_SHORT_LABELS: Readonly<Record<string, string>> = {
  lt30m: '30분 미만',
  lt2h: '2시간 미만',
  half_day: '반나절',
  day_plus: '하루 이상',
}

export const CLAIM_STATUS_SHORT_LABELS = {
  unconfirmed: '본인 설명 · 미확인',
  confirmed: '팀원 확인',
  disputed: '이의 있음',
} as const

function claimStatusText(claim: CaseSnapshot['claims'][number]): string {
  if (claim.status === 'confirmed') return `팀원 확인 ${claim.confirmedCount}명`
  return CLAIM_STATUS_SHORT_LABELS[claim.status]
}

/**
 * 템플릿 문장 틀(테스트가 "틀 밖의 글은 모두 스냅샷에서 왔다"를 확인할 때 씀). `{}` 자리에 스냅샷 글·개수가 들어갑니다.
 */
export const CASE_TEMPLATE_FRAMES = [
  '{} — {}',
  '확인한 결과: {}',
  '팀이 확인한 결과: {}',
  '역할: {} ({})',
  '직접 남긴 기록: {}',
  '{} {} · 회의 참석 {}',
  '선택: {} (선택지: {}) · 기준: {}',
  '회의에서 정한 것: {}',
  '막힘: {} → 해결: {} (걸린 시간: {})',
  '검증: {} · 조건: {} · 결과: {}',
  '지나고 보니: {}',
  '남은 질문: {}',
  '해결하지 못한 막힘: {}',
  '회고: {}',
  '진행 단계: {} → {}',
  '산출물: {}',
  '팀원 확인 {}명',
  ' / ',
  '; ',
  '…',
  ...Object.values(LOG_TAG_SHORT_LABELS),
  ...Object.values(TIME_BUCKET_SHORT_LABELS),
  ...Object.values(CLAIM_STATUS_SHORT_LABELS),
] as const

// ── 템플릿 초안 ──────────────────────────────────────────────────────────

const FIELD = 140

/** 로그 하나를 짧게 요약하는 스냅샷 글(태그별 주요 필드). */
export function logHeadline(log: CaseSnapshotLog): string {
  const p = log.payload
  switch (log.tag) {
    case 'stuck':
      return str(p.symptom) || log.body
    case 'solution':
      return str(p.method) || log.body
    case 'decision':
      return str(p.choice) || log.body
    case 'validation':
      return str(p.target) || log.body
    case 'meeting':
      return strList(p.decisions)[0] ?? log.body
    default:
      return log.body
  }
}

interface Picked {
  text: string
  citations: Array<Pick<CaseCitation, 'kind' | 'key'>>
  kind?: CaseSentenceKind
}

/**
 * 공개 스냅샷에서 케이스 스터디 템플릿 초안을 만듭니다(결정적: 같은 입력이면 같은 결과).
 *
 * 고르는 규칙(스냅샷 순서 = 기록 순서를 지킴):
 * - 문제와 결과: 공개 제목 — 학생 요약(요약 인용), 내가 쓴 첫 검증의 결과(없으면 팀의 첫 검증 결과를 "팀이 확인한 결과"로).
 * - 내 역할: 내 역할 선언(팀원 확인 → 미확인 → 이의 순, 최대 3), 내가 쓴 로그·참석한 회의의 종류별 개수.
 * - 핵심 결정: 내가 쓴 ⚖️결정, 그다음 내가 참석·작성한 회의의 결정 사항.
 * - 막힘과 해결: 내가 쓴 막힘 또는 내가 해결한 막힘 중 스냅샷의 💡해결이 가리키는 것(막힘 + 해결을 함께 인용).
 * - 검증: 내가 쓴 ✅검증.
 * - 한계·회고: 내 결정의 "지나고 보니", 내 검증의 남은 질문, 해결하지 못한 내 막힘, 내 🔁회고.
 * - 원본 링크: 마일스톤 순서, 내가 올린 공개 파일.
 * 직무별로 가운데 구역의 순서를 바꾸고, 첫 구역은 4개·나머지는 3개까지 고릅니다.
 */
export function generateCaseStudyDraft(
  snapshot: CaseSnapshot,
  releaseVersion: number,
  self: CaseSelf,
  jobTarget: CaseJobTarget,
): CaseSectionDraft[] {
  const logs = snapshot.logs
  const own = (l: CaseSnapshotLog) => self.ownLogKeys.has(l.key)
  const attended = (l: CaseSnapshotLog) => l.tag === 'meeting' && strList(l.payload.attendees).includes(self.memberKey)
  const solutionsFor = new Map<string, CaseSnapshotLog[]>()
  for (const l of logs) {
    if (l.tag === 'solution' && l.resolves) solutionsFor.set(l.resolves, [...(solutionsFor.get(l.resolves) ?? []), l])
  }
  const order = caseSectionOrder(jobTarget)
  const limitFor = (section: CaseSection) => (section === EMPHASIS[jobTarget][0] ? 4 : 3)

  const out: Record<CaseSection, Picked[]> = {
    problem_result: [],
    my_role: [],
    decisions: [],
    stuck_solved: [],
    validation: [],
    limits: [],
    sources: [],
  }

  // 문제와 결과
  const summary = clipText(snapshot.summary, 200)
  const title = clipText(snapshot.title, 80)
  if (title || summary) {
    out.problem_result.push({ text: summary ? `${title} — ${summary}` : title, citations: [{ kind: 'summary', key: SUMMARY_CITATION_KEY }] })
  }
  const validations = logs.filter((l) => l.tag === 'validation' && str(l.payload.result).trim())
  const ownValidation = validations.find(own)
  const resultLog = ownValidation ?? validations[0]
  if (resultLog) {
    const frame = ownValidation ? '확인한 결과' : '팀이 확인한 결과'
    out.problem_result.push({ text: `${frame}: ${clipText(resultLog.payload.result, FIELD)}`, citations: [{ kind: 'log', key: resultLog.key }] })
  }

  // 내 역할
  const STATUS_ORDER = { confirmed: 0, unconfirmed: 1, disputed: 2 } as const
  const myClaims = snapshot.claims
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.member === self.memberKey && c.text.trim())
    .sort((a, b) => STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status] || a.i - b.i)
    .slice(0, 3)
  for (const { c } of myClaims) {
    out.my_role.push({ text: `역할: ${clipText(c.text, FIELD)} (${claimStatusText(c)})`, citations: [{ kind: 'claim', key: c.key }] })
  }
  const mine = logs.filter(own)
  const attendedOnly = logs.filter((l) => attended(l) && !own(l))
  if (mine.length + attendedOnly.length > 0) {
    const counts = new Map<string, number>()
    for (const l of mine) counts.set(l.tag, (counts.get(l.tag) ?? 0) + 1)
    const parts = Object.keys(LOG_TAG_SHORT_LABELS)
      .filter((tag) => counts.has(tag))
      .map((tag) => `${LOG_TAG_SHORT_LABELS[tag]} ${counts.get(tag)}`)
    if (attendedOnly.length) parts.push(`회의 참석 ${attendedOnly.length}`)
    out.my_role.push({
      text: `직접 남긴 기록: ${parts.join(' · ')}`,
      citations: [...mine, ...attendedOnly].slice(0, CASE_CITATION_LIMIT).map((l) => ({ kind: 'log' as const, key: l.key })),
    })
  }

  // 핵심 결정
  for (const l of logs.filter((x) => x.tag === 'decision' && own(x))) {
    const choice = clipText(l.payload.choice, 80)
    if (!choice) continue
    const options = strList(l.payload.options).map((o) => clipText(o, 40)).join(' / ')
    const criteria = clipText(l.payload.criteria, FIELD)
    out.decisions.push({ text: `선택: ${choice} (선택지: ${options}) · 기준: ${criteria}`, citations: [{ kind: 'log', key: l.key }] })
  }
  for (const l of logs.filter((x) => x.tag === 'meeting' && (own(x) || attended(x)))) {
    const decided = strList(l.payload.decisions).slice(0, 3).map((d) => clipText(d, 60))
    if (decided.length) out.decisions.push({ text: `회의에서 정한 것: ${decided.join('; ')}`, citations: [{ kind: 'log', key: l.key }] })
  }

  // 막힘과 해결
  const unresolvedOwn: CaseSnapshotLog[] = []
  for (const stuck of logs.filter((x) => x.tag === 'stuck')) {
    const solutions = solutionsFor.get(stuck.key) ?? []
    const mySolution = solutions.find(own)
    if (!own(stuck) && !mySolution) continue
    const solution = mySolution ?? solutions[0]
    const symptom = clipText(logHeadline(stuck), 100)
    if (!symptom) continue
    if (!solution) {
      if (own(stuck)) unresolvedOwn.push(stuck)
      continue
    }
    const bucket = TIME_BUCKET_SHORT_LABELS[str(stuck.payload.timeBucket)]
    out.stuck_solved.push({
      text: `막힘: ${symptom} → 해결: ${clipText(logHeadline(solution), FIELD)}${bucket ? ` (걸린 시간: ${bucket})` : ''}`,
      citations: [
        { kind: 'log', key: stuck.key },
        { kind: 'log', key: solution.key },
      ],
    })
  }

  // 검증
  for (const l of validations.filter(own)) {
    out.validation.push({
      text: `검증: ${clipText(l.payload.target, 80)} · 조건: ${clipText(l.payload.conditions, 80)} · 결과: ${clipText(l.payload.result, FIELD)}`,
      citations: [{ kind: 'log', key: l.key }],
    })
  }

  // 한계·회고
  for (const l of logs.filter((x) => x.tag === 'decision' && own(x) && str(x.payload.hindsight).trim())) {
    out.limits.push({ text: `지나고 보니: ${clipText(l.payload.hindsight, FIELD)}`, citations: [{ kind: 'log', key: l.key }] })
  }
  for (const l of validations.filter((x) => own(x) && str(x.payload.openQuestions).trim())) {
    out.limits.push({ text: `남은 질문: ${clipText(l.payload.openQuestions, FIELD)}`, citations: [{ kind: 'log', key: l.key }] })
  }
  for (const l of unresolvedOwn) {
    out.limits.push({ text: `해결하지 못한 막힘: ${clipText(logHeadline(l), FIELD)}`, citations: [{ kind: 'log', key: l.key }] })
  }
  for (const l of logs.filter((x) => x.tag === 'retro' && own(x) && x.body.trim())) {
    out.limits.push({ text: `회고: ${clipText(l.body, FIELD)}`, citations: [{ kind: 'log', key: l.key }] })
  }

  // 원본 링크
  const milestones = [...snapshot.milestones].sort((a, b) => a.position - b.position).filter((m) => m.title.trim())
  if (milestones.length) {
    out.sources.push({
      text: `진행 단계: ${milestones.map((m) => clipText(m.title, 30)).join(' → ')}`,
      citations: milestones.slice(0, CASE_CITATION_LIMIT).map((m) => ({ kind: 'milestone' as const, key: m.key })),
    })
  }
  for (const a of snapshot.artifacts.filter((x) => self.ownArtifactIds.has(x.artifactVersionId)).slice(0, 5)) {
    out.sources.push({ text: `산출물: ${clipText(a.displayName, 80)}`, citations: [{ kind: 'artifact', key: a.artifactVersionId }] })
  }

  const limits: Record<CaseSection, number> = {
    problem_result: 2,
    my_role: 4,
    decisions: limitFor('decisions'),
    stuck_solved: limitFor('stuck_solved'),
    validation: limitFor('validation'),
    limits: 5,
    sources: 6,
  }
  return order.map((key) => ({
    key,
    sentences: out[key].slice(0, limits[key]).map((p) => ({
      text: clipText(p.text, CASE_SENTENCE_MAX),
      kind: p.kind ?? 'evidence',
      citations: dedupeCitations(p.citations).map((c) => ({ releaseVersion, kind: c.kind, key: c.key })),
    })),
  }))
}

function dedupeCitations<T extends Pick<CaseCitation, 'kind' | 'key'>>(citations: readonly T[]): T[] {
  const seen = new Set<string>()
  return citations.filter((c) => {
    const id = citationId(c)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

// ── 입력 검증(편집) ──────────────────────────────────────────────────────

export type CaseSectionsCheck = { ok: true; sections: CaseSectionDraft[] } | { ok: false; fields: Record<string, string> }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 편집 요청의 구역·문장·인용을 검증하고 정규화합니다. 오류는 필드 경로별 코드(422).
 * - 구역 키는 알려진 것만, 한 번씩. 빠진 구역은 빈 구역.
 * - 문장: 글 1–500자(공백 정리), 구역당 12개·전체 60개, kind는 evidence(기본)·reflection(한계·회고 구역에서만).
 * - 인용: 구역당이 아니라 문장당 12개, 중복 제거, 고정한 release 버전과 같아야 하고(`stale_release`) 스냅샷에 있는 키여야 함(`not_found`).
 * 인용 없는 문장은 여기서 막지 않습니다(초안 허용, 게시 때 `findUncitedSentences`로 막음).
 */
export function normalizeCaseSections(raw: unknown, snapshot: CaseSnapshot, releaseVersion: number, jobTarget: CaseJobTarget): CaseSectionsCheck {
  const fields: Record<string, string> = {}
  if (!Array.isArray(raw)) return { ok: false, fields: { sections: 'invalid' } }
  if (raw.length > CASE_SECTIONS.length) return { ok: false, fields: { sections: 'too_many' } }
  const byKey = new Map<CaseSection, CaseSentenceDraft[]>()
  let total = 0
  raw.forEach((section, si) => {
    const base = `sections.${si}`
    if (!isRecord(section)) {
      fields[base] = 'invalid'
      return
    }
    const key = section.key
    if (typeof key !== 'string' || !(CASE_SECTIONS as readonly string[]).includes(key)) {
      fields[`${base}.key`] = 'invalid'
      return
    }
    if (byKey.has(key as CaseSection)) {
      fields[`${base}.key`] = 'duplicate'
      return
    }
    const sentences = section.sentences ?? []
    if (!Array.isArray(sentences)) {
      fields[`${base}.sentences`] = 'invalid'
      return
    }
    if (sentences.length > CASE_SECTION_SENTENCE_LIMIT) {
      fields[`${base}.sentences`] = 'too_many'
      return
    }
    total += sentences.length
    const out: CaseSentenceDraft[] = []
    sentences.forEach((sentence, i) => {
      const path = `${base}.sentences.${i}`
      if (!isRecord(sentence)) {
        fields[path] = 'invalid'
        return
      }
      const allowed = new Set(['text', 'kind', 'citations'])
      if (Object.keys(sentence).some((k) => !allowed.has(k))) {
        fields[path] = 'unknown_key'
        return
      }
      if (typeof sentence.text !== 'string') {
        fields[`${path}.text`] = sentence.text === undefined ? 'required' : 'invalid'
        return
      }
      const text = sentence.text.replace(/\s+/g, ' ').trim()
      if (!text) {
        fields[`${path}.text`] = 'required'
        return
      }
      if ([...text].length > CASE_SENTENCE_MAX) {
        fields[`${path}.text`] = 'too_long'
        return
      }
      const kind = sentence.kind ?? 'evidence'
      if (kind !== 'evidence' && kind !== 'reflection') {
        fields[`${path}.kind`] = 'invalid'
        return
      }
      if (kind === 'reflection' && key !== REFLECTION_SECTION) {
        fields[`${path}.kind`] = 'not_allowed'
        return
      }
      const rawCitations = sentence.citations ?? []
      if (!Array.isArray(rawCitations)) {
        fields[`${path}.citations`] = 'invalid'
        return
      }
      const citations: CaseCitation[] = []
      for (const [ci, c] of rawCitations.entries()) {
        const cpath = `${path}.citations.${ci}`
        if (!isRecord(c) || typeof c.key !== 'string' || typeof c.kind !== 'string' || !(CITATION_KINDS as readonly string[]).includes(c.kind)) {
          fields[cpath] = 'invalid'
          return
        }
        if (c.releaseVersion !== releaseVersion) {
          fields[cpath] = Number.isInteger(c.releaseVersion) ? 'stale_release' : 'invalid'
          return
        }
        const citation: CaseCitation = { releaseVersion, kind: c.kind as CitationKind, key: c.key }
        if (!citationExists(snapshot, citation)) {
          fields[cpath] = 'not_found'
          return
        }
        citations.push(citation)
      }
      const unique = dedupeCitations(citations)
      if (unique.length > CASE_CITATION_LIMIT) {
        fields[`${path}.citations`] = 'too_many'
        return
      }
      out.push({ text, kind, citations: unique })
    })
    byKey.set(key as CaseSection, out)
  })
  if (total > CASE_TOTAL_SENTENCE_LIMIT) fields.sections = 'too_many'
  if (Object.keys(fields).length > 0) return { ok: false, fields }
  return { ok: true, sections: caseSectionOrder(jobTarget).map((key) => ({ key, sentences: byKey.get(key) ?? [] })) }
}

/**
 * 게시를 막는 출처 없는 문장(한계·회고 구역의 reflection은 예외 — 단 AI 다듬기로 받아들인 문장(aiGenerated)은 예외 없음, E-14).
 * 구역 키와 그 구역 안의 순서.
 */
export function findUncitedSentences(sections: readonly CaseSectionDraft[]): Array<{ section: CaseSection; index: number }> {
  const out: Array<{ section: CaseSection; index: number }> = []
  for (const s of sections) {
    s.sentences.forEach((sentence, index) => {
      if (sentence.citations.length > 0) return
      if (sentence.kind === 'reflection' && s.key === REFLECTION_SECTION && !sentence.aiGenerated) return
      out.push({ section: s.key, index })
    })
  }
  return out
}

/** 공개 전 점검(publication-checks)에 넣을 항목: 케이스 제목과 모든 문장. */
export function caseStudyCheckItems(caseStudy: { title: string; sections: readonly CaseSectionDraft[] }): CheckItem[] {
  const items: CheckItem[] = [{ kind: 'text', location: { kind: 'case_study', field: 'title' }, value: caseStudy.title }]
  for (const s of caseStudy.sections) {
    s.sentences.forEach((sentence, i) => {
      items.push({ kind: 'text', location: { kind: 'case_study', key: s.key, field: `sections.${s.key}.${i}` }, value: sentence.text })
    })
  }
  return items
}

/** 포트폴리오 판의 사용자가 쓴 글(한 줄 소개·역량 이름·자기 선언 스킬). */
export function editionCheckItems(edition: { headline: string | null; competencies: ReadonlyArray<{ label: string }>; skillsDeclared: readonly string[] }): CheckItem[] {
  const items: CheckItem[] = []
  if (edition.headline) items.push({ kind: 'text', location: { kind: 'portfolio', field: 'headline' }, value: edition.headline })
  edition.competencies.forEach((c, i) => items.push({ kind: 'text', location: { kind: 'portfolio', field: `competencies.${i}.label` }, value: c.label }))
  edition.skillsDeclared.forEach((s, i) => items.push({ kind: 'text', location: { kind: 'portfolio', field: `skillsDeclared.${i}` }, value: s }))
  return items
}

// ── 인용 표시 ────────────────────────────────────────────────────────────

const TAG_EMOJI: Readonly<Record<string, string>> = {
  progress: '🔨',
  stuck: '🧱',
  solution: '💡',
  decision: '⚖️',
  meeting: '🗣️',
  validation: '✅',
  retro: '🔁',
}

/** 인용 칩의 짧은 표시(종류 + 스냅샷 글 일부). 스냅샷에 없으면 null. */
export function citationLabel(snapshot: CaseSnapshot, citation: Pick<CaseCitation, 'kind' | 'key'>): string | null {
  switch (citation.kind) {
    case 'summary':
      return citation.key === SUMMARY_CITATION_KEY ? '📝 사례 요약' : null
    case 'log': {
      const log = snapshot.logs.find((l) => l.key === citation.key)
      if (!log) return null
      const text = clipText(logHeadline(log), 30)
      return `${TAG_EMOJI[log.tag] ?? ''} ${LOG_TAG_SHORT_LABELS[log.tag] ?? '기록'}${text ? ` · ${text}` : ''}`.trim()
    }
    case 'claim': {
      const claim = snapshot.claims.find((c) => c.key === citation.key)
      return claim ? `🙋 역할 선언 · ${clipText(claim.text, 30)}` : null
    }
    case 'milestone': {
      const m = snapshot.milestones.find((x) => x.key === citation.key)
      return m ? `🏁 마일스톤 · ${clipText(m.title, 30)}` : null
    }
    case 'artifact': {
      const a = snapshot.artifacts.find((x) => x.artifactVersionId === citation.key)
      return a ? `📎 산출물 · ${clipText(a.displayName, 30)}` : null
    }
    default:
      return null
  }
}

/** 공개 사례 페이지 안의 위치(PublicSnapshotView의 `public-…` id). */
export function citationAnchor(citation: Pick<CaseCitation, 'kind' | 'key'>): string {
  if (citation.kind === 'summary') return 'public-title'
  if (citation.kind === 'artifact') return `public-f-${citation.key}`
  return `public-${citation.key}`
}

export const citationPath = (slug: string, citation: Pick<CaseCitation, 'kind' | 'key'>) => `/p/${slug}#${citationAnchor(citation)}`

// ── 역량 × 근거 ──────────────────────────────────────────────────────────

export const EVIDENCE_CATEGORIES = [
  'decision',
  'stuck_resolved',
  'stuck',
  'solution',
  'validation',
  'meeting',
  'progress',
  'retro',
  'claim_confirmed',
  'claim',
  'milestone',
  'artifact',
] as const
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number]
export const EVIDENCE_CATEGORY_LABELS: Readonly<Record<EvidenceCategory, string>> = {
  decision: '결정',
  stuck_resolved: '막힘 해결',
  stuck: '막힘',
  solution: '해결',
  validation: '검증',
  meeting: '회의 정리',
  progress: '진행',
  retro: '회고',
  claim_confirmed: '팀원 확인',
  claim: '역할 선언',
  milestone: '마일스톤',
  artifact: '산출물',
}

/** 인용 하나의 근거 종류. 요약·스냅샷에 없는 항목은 null(근거로 세지 않음). */
export function evidenceCategory(snapshot: CaseSnapshot, citation: Pick<CaseCitation, 'kind' | 'key'>): EvidenceCategory | null {
  switch (citation.kind) {
    case 'log': {
      const log = snapshot.logs.find((l) => l.key === citation.key)
      if (!log) return null
      if (log.tag === 'stuck') return snapshot.logs.some((l) => l.tag === 'solution' && l.resolves === log.key) ? 'stuck_resolved' : 'stuck'
      return (EVIDENCE_CATEGORIES as readonly string[]).includes(log.tag) ? (log.tag as EvidenceCategory) : null
    }
    case 'claim': {
      const claim = snapshot.claims.find((c) => c.key === citation.key)
      if (!claim) return null
      return claim.status === 'confirmed' ? 'claim_confirmed' : 'claim'
    }
    case 'milestone':
      return citationExists(snapshot, citation) ? 'milestone' : null
    case 'artifact':
      return citationExists(snapshot, citation) ? 'artifact' : null
    default:
      return null
  }
}

export interface EvidenceCount {
  category: EvidenceCategory
  label: string
  count: number
}

/**
 * 근거 종류별 개수(정해진 순서). 같은 항목은 한 번, 같은 칸에 그 막힘이 함께 있는 💡해결은 "막힘 해결" 하나로 셉니다.
 * 점수·가중치는 없습니다.
 */
export function countEvidence(snapshot: CaseSnapshot, citations: ReadonlyArray<Pick<CaseCitation, 'kind' | 'key'>>): EvidenceCount[] {
  const unique = dedupeCitations(citations)
  const citedLogKeys = new Set(unique.filter((c) => c.kind === 'log').map((c) => c.key))
  const counts = new Map<EvidenceCategory, number>()
  for (const c of unique) {
    const category = evidenceCategory(snapshot, c)
    if (!category) continue
    if (category === 'solution') {
      const log = snapshot.logs.find((l) => l.key === c.key)
      if (log?.resolves && citedLogKeys.has(log.resolves)) continue
    }
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return EVIDENCE_CATEGORIES.filter((c) => counts.has(c)).map((category) => ({
    category,
    label: EVIDENCE_CATEGORY_LABELS[category],
    count: counts.get(category)!,
  }))
}

export const formatEvidenceCounts = (counts: readonly EvidenceCount[]) => counts.map((c) => `${c.label} ${c.count}`).join(' · ')

export interface CompetencyPreset {
  id: string
  label: string
  /** 이 역량의 근거로 먼저 추천할 종류(사용자가 고치거나 뺄 수 있음). */
  categories: readonly EvidenceCategory[]
}

const PRESET_LIST: readonly CompetencyPreset[] = [
  { id: 'api_design', label: 'API 설계', categories: ['decision'] },
  { id: 'data_modeling', label: '데이터 모델링', categories: ['decision', 'artifact'] },
  { id: 'debugging', label: '디버깅', categories: ['stuck_resolved', 'stuck', 'solution'] },
  { id: 'testing', label: '테스트·검증', categories: ['validation'] },
  { id: 'reliability', label: '성능·안정성', categories: ['validation', 'stuck_resolved'] },
  { id: 'collaboration', label: '협업', categories: ['meeting', 'claim_confirmed'] },
  { id: 'ui_implementation', label: 'UI 구현', categories: ['progress', 'artifact'] },
  { id: 'usability', label: '사용성 검증', categories: ['validation'] },
  { id: 'state_management', label: '상태 관리', categories: ['decision'] },
  { id: 'accessibility', label: '접근성', categories: ['validation'] },
  { id: 'data_preparation', label: '데이터 수집·정제', categories: ['progress', 'stuck_resolved'] },
  { id: 'analysis', label: '분석·모델링', categories: ['decision', 'validation'] },
  { id: 'experiment', label: '실험·검증', categories: ['validation'] },
  { id: 'visualization', label: '시각화', categories: ['artifact'] },
  { id: 'problem_definition', label: '문제 정의', categories: ['decision', 'milestone'] },
  { id: 'scope', label: '범위 조정', categories: ['decision'] },
  { id: 'decision_making', label: '의사결정', categories: ['decision', 'meeting'] },
  { id: 'planning', label: '일정 관리', categories: ['milestone'] },
  { id: 'user_validation', label: '사용자 검증', categories: ['validation'] },
  { id: 'user_research', label: '사용자 조사', categories: ['validation', 'meeting'] },
  { id: 'information_architecture', label: '정보 구조', categories: ['decision', 'artifact'] },
  { id: 'prototyping', label: '프로토타이핑', categories: ['artifact', 'progress'] },
  { id: 'problem_solving', label: '문제 해결', categories: ['stuck_resolved', 'solution'] },
  { id: 'reflection', label: '회고·학습', categories: ['retro'] },
]

export const COMPETENCY_PRESETS: Readonly<Record<string, CompetencyPreset>> = Object.fromEntries(PRESET_LIST.map((p) => [p.id, p]))

/** 직무별 역량 프리셋(행 후보). 직접 입력도 됩니다. */
export const JOB_TARGET_PRESETS: Readonly<Record<CaseJobTarget, readonly string[]>> = {
  backend: ['api_design', 'data_modeling', 'debugging', 'testing', 'reliability', 'collaboration'],
  frontend: ['ui_implementation', 'usability', 'state_management', 'debugging', 'accessibility', 'collaboration'],
  data: ['data_preparation', 'analysis', 'experiment', 'visualization', 'debugging', 'collaboration'],
  pm: ['problem_definition', 'scope', 'decision_making', 'planning', 'user_validation', 'collaboration'],
  design: ['user_research', 'information_architecture', 'prototyping', 'usability', 'decision_making', 'collaboration'],
  general: ['problem_solving', 'decision_making', 'testing', 'collaboration', 'reflection'],
}

export const FEATURED_CASE_LIMIT = 5
export const COMPETENCY_LIMIT = 12
export const COMPETENCY_LABEL_MAX = 40
export const SKILL_LIMIT = 20
export const SKILL_LABEL_MAX = 40
export const EDITION_HEADLINE_MAX = 120

/** 케이스가 인용한 항목 중 프리셋 종류에 맞는 것(추천 근거). 사용자가 고르지 않으면 서버도 이 규칙으로 채웁니다. */
export function suggestCompetencyEvidence(
  snapshot: CaseSnapshot,
  citedByCase: ReadonlyArray<Pick<CaseCitation, 'kind' | 'key'>>,
  presetId: string,
): Array<Pick<CaseCitation, 'kind' | 'key'>> {
  const preset = COMPETENCY_PRESETS[presetId]
  if (!preset) return []
  return dedupeCitations(citedByCase).filter((c) => {
    const category = evidenceCategory(snapshot, c)
    return category !== null && preset.categories.includes(category)
  })
}

export interface MatrixColumnInput {
  ref: string
  available: boolean
  snapshot: CaseSnapshot | null
}

export interface MatrixRowInput {
  label: string
  preset: string | null
  evidence: ReadonlyArray<{ column: string; citations: ReadonlyArray<Pick<CaseCitation, 'kind' | 'key'>> }>
}

export interface MatrixCell {
  column: string
  available: boolean
  counts: EvidenceCount[]
  /** "결정 2 · 막힘 해결 1", 근거 없으면 "–", 볼 수 없는 사례면 "볼 수 없음". */
  text: string
  citations: Array<Pick<CaseCitation, 'kind' | 'key'>>
}

export interface MatrixRow {
  label: string
  preset: string | null
  /** 볼 수 있는 칸에 근거가 하나라도 있으면 true("경험 근거" 역량). */
  evidenceBacked: boolean
  cells: MatrixCell[]
}

/** 역량 × 근거 매트릭스: 칸마다 근거의 종류와 개수만. 볼 수 없는 사례의 칸은 근거를 싣지 않습니다. */
export function computeCompetencyMatrix(columns: readonly MatrixColumnInput[], rows: readonly MatrixRowInput[]): MatrixRow[] {
  return rows.map((row) => {
    const cells = columns.map((col): MatrixCell => {
      if (!col.available || !col.snapshot) return { column: col.ref, available: false, counts: [], text: '볼 수 없음', citations: [] }
      const snapshot = col.snapshot
      const citations = dedupeCitations(row.evidence.filter((e) => e.column === col.ref).flatMap((e) => e.citations)).filter((c) =>
        citationExists(snapshot, c),
      )
      const counts = countEvidence(snapshot, citations)
      return { column: col.ref, available: true, counts, text: counts.length ? formatEvidenceCounts(counts) : '–', citations: counts.length ? citations : [] }
    })
    return { label: row.label, preset: row.preset, evidenceBacked: cells.some((c) => c.counts.length > 0), cells }
  })
}

/** 역량·스킬 이름 비교용 키(공백 정리 + NFKC + 소문자). */
export function competencyLabelKey(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko-KR')
}
