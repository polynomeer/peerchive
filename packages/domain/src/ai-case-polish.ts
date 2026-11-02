/**
 * AI 케이스 다듬기 규칙 (E-14, PROOFU_EVOLUTION_PLAN §10.3·§15, DELIVERY_PLAN §4.4, ADR 0059).
 *
 * - AI에 보내는 근거는 **케이스가 고정한 release 스냅샷(운영 조치로 가린 항목을 뺀 사본)** 안에서만 고릅니다: 공개 요약, 케이스 문장이 이미
 *   인용한 항목, 이 학생이 쓴 로그·참석한 회의·본인 역할 선언·마일스톤·이 학생이 올린 파일. 비공개 작업 테이블, 다른 release, 다른 과제는
 *   이 함수가 볼 수조차 없습니다(입력이 스냅샷뿐). 팀원 이름은 보내지 않고 "본인/팀원"만 표시합니다.
 * - AI는 문장마다 하나의 다듬은 글과 인용 `{kind, key}`를 냅니다. 서버는 **보낸 근거 목록에 없는 인용을 버리고**, 남은 인용이 없으면
 *   `uncited`로 표시합니다(받아들여도 출처를 붙이거나 지우기 전에는 게시할 수 없음).
 * - 다듬기 대상은 출처가 필요한 문장(evidence)뿐입니다. 한계·회고 구역의 "본인 회고"(reflection)는 학생 자신의 말이라 보내지도 바꾸지도 않습니다.
 */
import { neutralizePromptText } from './ai-retro'
import {
  CASE_CITATION_LIMIT,
  CASE_SECTION_LABELS,
  CASE_SENTENCE_MAX,
  CITATION_KINDS,
  CLAIM_STATUS_SHORT_LABELS,
  LOG_TAG_SHORT_LABELS,
  REFLECTION_SECTION,
  SUMMARY_CITATION_KEY,
  TIME_BUCKET_SHORT_LABELS,
  type CaseCitation,
  type CaseSection,
  type CaseSectionDraft,
  type CaseSelf,
  type CaseSnapshot,
  type CaseSnapshotLog,
  type CitationKind,
  citationExists,
  clipText,
} from './portfolio'

/** 케이스마다 하루(UTC) AI 다듬기 횟수. */
export const AI_CASE_POLISH_DAILY_LIMIT = 5
/** 받아들이지도 버리지도 않은 제안을 두는 기간. */
export const AI_CASE_POLISH_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 보내는 근거 항목 수 상한(요약·이미 인용한 항목이 먼저). */
export const AI_CASE_EVIDENCE_LIMIT = 60
/** 근거 항목 하나의 글 상한(글자). */
export const AI_CASE_EVIDENCE_TEXT_MAX = 300
/** 공개 화면·인쇄·PDF에 붙는 표시(케이스 generator가 ai일 때). */
export const AI_CASE_POLISH_NOTE = 'AI로 다듬음 · 다듬은 문장은 모두 근거 기록에 연결됨'

export interface PolishEvidence {
  kind: CitationKind
  key: string
  /** 이 학생이 쓴(선언한·올린) 항목인지. 요약·마일스톤은 팀 것이라 false. */
  mine: boolean
  text: string
}

/** 다듬을 문장(지금 케이스의 evidence 문장). id는 프롬프트 안에서만 쓰는 `S1`… */
export interface PolishSentenceRef {
  id: string
  section: CaseSection
  index: number
  text: string
  citations: Array<Pick<CaseCitation, 'kind' | 'key'>>
}

export interface PolishSuggestion {
  section: CaseSection
  index: number
  text: string
  citations: Array<Pick<CaseCitation, 'kind' | 'key'>>
  /** 보낸 근거에 맞는 인용이 하나도 남지 않음(강조 표시, 받아들여도 게시 불가). */
  uncited: boolean
}

export interface PolishRawSentence {
  id: string
  text: string
  citations: ReadonlyArray<{ kind: string; key: string }>
}

const refId = (c: { kind: string; key: string }) => `${c.kind}:${c.key}`
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [])

/**
 * 다듬을 문장: 본인 회고(한계·회고 구역의 reflection)와 **운영 조치로 가린 항목을 인용한 문장**(공개 화면에서도 자리 표시로 바뀌는 글,
 * T-15)을 뺀 모든 문장. `isHidden`은 가린 항목인지(웹이 release의 가린 항목 목록으로 만듦).
 */
export function polishableSentences(
  sections: readonly CaseSectionDraft[],
  isHidden: (citation: Pick<CaseCitation, 'kind' | 'key'>) => boolean = () => false,
): PolishSentenceRef[] {
  const out: PolishSentenceRef[] = []
  for (const s of sections) {
    s.sentences.forEach((sentence, index) => {
      if (sentence.kind === 'reflection' && s.key === REFLECTION_SECTION) return
      if (sentence.citations.some(isHidden)) return
      out.push({ id: `S${out.length + 1}`, section: s.key, index, text: sentence.text, citations: sentence.citations.map((c) => ({ kind: c.kind, key: c.key })) })
    })
  }
  return out
}

function logText(log: CaseSnapshotLog): string {
  const p = log.payload
  const label = LOG_TAG_SHORT_LABELS[log.tag] ?? '기록'
  const parts: string[] = []
  const add = (name: string, value: string) => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (v) parts.push(`${name}: ${v}`)
  }
  switch (log.tag) {
    case 'decision':
      add('선택', str(p.choice))
      add('선택지', strList(p.options).join(' / '))
      add('기준', str(p.criteria))
      add('지나고 보니', str(p.hindsight))
      break
    case 'stuck':
      add('증상', str(p.symptom))
      add('걸린 시간', TIME_BUCKET_SHORT_LABELS[str(p.timeBucket)] ?? '')
      break
    case 'solution':
      add('방법', str(p.method))
      break
    case 'validation':
      add('대상', str(p.target))
      add('조건', str(p.conditions))
      add('결과', str(p.result))
      add('남은 질문', str(p.openQuestions))
      break
    case 'meeting':
      add('정한 것', strList(p.decisions).join('; '))
      break
    default:
      break
  }
  add('본문', log.body)
  return `[${label}] ${parts.join(' · ')}`
}

/** 근거 항목 하나의 글(스냅샷 글만, 잘라서). 스냅샷에 없으면 null. */
export function polishEvidenceText(snapshot: CaseSnapshot, citation: Pick<CaseCitation, 'kind' | 'key'>): string | null {
  let text: string | null = null
  switch (citation.kind) {
    case 'summary':
      text = citation.key === SUMMARY_CITATION_KEY ? `[공개 제목·요약] ${snapshot.title}${snapshot.summary ? ` — ${snapshot.summary}` : ''}` : null
      break
    case 'log': {
      const log = snapshot.logs.find((l) => l.key === citation.key)
      text = log ? logText(log) : null
      break
    }
    case 'claim': {
      const claim = snapshot.claims.find((c) => c.key === citation.key)
      text = claim ? `[역할 선언] ${claim.text} (${CLAIM_STATUS_SHORT_LABELS[claim.status]})` : null
      break
    }
    case 'milestone': {
      const m = snapshot.milestones.find((x) => x.key === citation.key)
      text = m ? `[마일스톤 ${m.position + 1}] ${m.title}` : null
      break
    }
    case 'artifact': {
      const a = snapshot.artifacts.find((x) => x.artifactVersionId === citation.key)
      text = a ? `[산출물] ${a.displayName}` : null
      break
    }
    default:
      text = null
  }
  return text === null ? null : clipText(text, AI_CASE_EVIDENCE_TEXT_MAX)
}

/**
 * AI에 보낼 근거 목록. `snapshot`은 운영 조치로 가린 항목을 뺀 사본이어야 합니다(웹이 `redactHiddenItems`로 만듦).
 * 순서(상한 `AI_CASE_EVIDENCE_LIMIT`까지): 공개 요약 → 케이스 문장이 이미 인용한 항목(문장 순서) → 내가 쓴 로그 → 참석한 회의 →
 * 본인 역할 선언 → 마일스톤 → 내가 올린 파일. 스냅샷에 없는(가린·다른 release) 항목은 넣지 않습니다.
 * 팀원이 쓴 항목은 케이스가 이미 인용한 것만 들어갑니다(학생이 고른 범위).
 */
export function collectPolishEvidence(snapshot: CaseSnapshot, self: CaseSelf, sections: readonly CaseSectionDraft[]): PolishEvidence[] {
  const out: PolishEvidence[] = []
  const seen = new Set<string>()
  const ownLog = (key: string) => self.ownLogKeys.has(key)
  const isMine = (c: Pick<CaseCitation, 'kind' | 'key'>): boolean => {
    if (c.kind === 'log') return ownLog(c.key)
    if (c.kind === 'claim') return snapshot.claims.some((x) => x.key === c.key && x.member === self.memberKey)
    if (c.kind === 'artifact') return self.ownArtifactIds.has(c.key)
    return false
  }
  const push = (c: Pick<CaseCitation, 'kind' | 'key'>) => {
    if (out.length >= AI_CASE_EVIDENCE_LIMIT) return
    const id = refId(c)
    if (seen.has(id) || !citationExists(snapshot, c)) return
    const text = polishEvidenceText(snapshot, c)
    if (!text) return
    seen.add(id)
    out.push({ kind: c.kind, key: c.key, mine: isMine(c), text })
  }
  push({ kind: 'summary', key: SUMMARY_CITATION_KEY })
  for (const s of sections) for (const sentence of s.sentences) for (const c of sentence.citations) push(c)
  for (const l of snapshot.logs) if (ownLog(l.key)) push({ kind: 'log', key: l.key })
  for (const l of snapshot.logs) {
    if (l.tag === 'meeting' && strList(l.payload.attendees).includes(self.memberKey)) push({ kind: 'log', key: l.key })
  }
  for (const c of snapshot.claims) if (c.member === self.memberKey) push({ kind: 'claim', key: c.key })
  for (const m of [...snapshot.milestones].sort((a, b) => a.position - b.position)) push({ kind: 'milestone', key: m.key })
  for (const a of snapshot.artifacts) if (self.ownArtifactIds.has(a.artifactVersionId)) push({ kind: 'artifact', key: a.artifactVersionId })
  return out
}

/** 속성 값에 넣을 키(스냅샷 키·파일 버전 id)를 안전한 글자로만. */
const attr = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '')

/** user 메시지 본문(직무 관점·근거·문장). 근거·문장 글은 구획 태그 안에 넣고 닫는 태그를 무력화합니다. */
export function renderPolishInput(jobTargetLabel: string, evidence: readonly PolishEvidence[], sentences: readonly PolishSentenceRef[]): string {
  // 직무 이름·구역 이름은 코드의 고정 라벨입니다(사용자 글 아님).
  const lines = [`<case job_target="${jobTargetLabel}">`, '<evidence>']
  for (const e of evidence) {
    lines.push(`<item kind="${e.kind}" key="${attr(e.key)}" by="${e.mine ? '본인' : '팀'}">${neutralizePromptText(e.text)}</item>`)
  }
  lines.push('</evidence>', '<sentences>')
  for (const s of sentences) {
    const cites = s.citations.map((c) => `${c.kind}:${attr(c.key)}`).join(' ')
    lines.push(`<s id="${s.id}" section="${CASE_SECTION_LABELS[s.section]}" cites="${cites}">${neutralizePromptText(s.text)}</s>`)
  }
  lines.push('</sentences>', '</case>')
  return lines.join('\n')
}

/**
 * AI 출력 검증. 모르는·중복 id는 버리고, 글은 공백 정리 후 1–500자(넘으면 자름), 인용은 **보낸 근거 목록에 있는 것만**(중복 제거, 12개).
 * 남은 인용이 없으면 uncited. 글·인용이 지금과 같으면 제안하지 않습니다. 결과는 문장 순서.
 */
export function validatePolishOutput(
  raw: readonly PolishRawSentence[],
  sentences: readonly PolishSentenceRef[],
  evidence: readonly PolishEvidence[],
): { suggestions: PolishSuggestion[]; droppedCitations: number } {
  const allowed = new Set(evidence.map(refId))
  const byId = new Map(sentences.map((s) => [s.id, s]))
  const used = new Map<string, PolishSuggestion>()
  let droppedCitations = 0
  for (const r of raw) {
    const ref = byId.get(r.id)
    if (!ref || used.has(r.id)) continue
    const text = clipText(r.text, CASE_SENTENCE_MAX)
    if (!text) continue
    const citations: Array<Pick<CaseCitation, 'kind' | 'key'>> = []
    const seen = new Set<string>()
    for (const c of r.citations) {
      const id = refId(c)
      if (!(CITATION_KINDS as readonly string[]).includes(c.kind) || !allowed.has(id)) {
        droppedCitations += 1
        continue
      }
      if (seen.has(id) || citations.length >= CASE_CITATION_LIMIT) continue
      seen.add(id)
      citations.push({ kind: c.kind as CitationKind, key: c.key })
    }
    const before = new Set(ref.citations.map(refId))
    const same = text === ref.text && citations.length === before.size && citations.every((c) => before.has(refId(c)))
    if (same) continue
    used.set(r.id, { section: ref.section, index: ref.index, text, citations, uncited: citations.length === 0 })
  }
  const suggestions = sentences.map((s) => used.get(s.id)).filter((s): s is PolishSuggestion => !!s)
  return { suggestions, droppedCitations }
}

/**
 * 편집 저장 때 AI 문장 표시를 이어 붙입니다: 새 문장의 글이 이전 AI 문장 글과 똑같으면(구역을 옮겨도, 한 번씩 짝지음) aiGenerated를 유지합니다.
 * 그래서 AI 문장을 한계·회고로 옮겨 "본인 회고"로 바꿔도 출처 없이는 게시할 수 없습니다. 글을 고치면 학생의 문장이 됩니다
 * (케이스의 generator `ai`는 그대로 남음).
 */
export function carryAiGenerated(previous: readonly CaseSectionDraft[], next: readonly CaseSectionDraft[]): CaseSectionDraft[] {
  const pool = new Map<string, number>()
  for (const s of previous) for (const x of s.sentences) if (x.aiGenerated) pool.set(x.text, (pool.get(x.text) ?? 0) + 1)
  return next.map((s) => ({
    key: s.key,
    sentences: s.sentences.map((x) => {
      const left = pool.get(x.text) ?? 0
      if (left > 0) pool.set(x.text, left - 1)
      return { ...x, aiGenerated: left > 0 }
    }),
  }))
}
