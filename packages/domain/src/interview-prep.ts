/**
 * 면접 준비 팩 (E-06, PROOFU_EVOLUTION_PLAN §10.5, DELIVERY_PLAN §4.4 E-06, ADR 0050).
 *
 * 케이스 스터디마다 그 케이스 문장이 **인용한** 공개 스냅샷의 ⚖️결정·회의 결정·🧱막힘 로그에서 예상 질문을 만들고, 출처가 없는 일반 질문
 * (가장 큰 실패·팀 내 의견 충돌·다시 한다면)을 더합니다. 이 파일은 규칙만 담고 런타임 의존성이 없습니다.
 *
 * - **결정적 템플릿**: 같은 스냅샷·같은 인용이면 같은 질문(같은 순서·같은 키). 질문 글은 고정한 한국어 틀에 스냅샷 글(선택·선택지·막힘 증상·
 *   회의 결정)을 잘라 넣은 것뿐이며 사실을 만들어 내지 않습니다. AI 생성(E-12 이후)은 `InterviewQuestionGenerator` 자리에 붙일 수 있지만
 *   같은 키 규칙·출처 규칙(근거 있는 질문은 스냅샷 로그 하나를 가리킴)을 지켜야 합니다.
 * - **안정된 질문 키**: `<규칙>:<스냅샷 로그 키>`(근거 있는 질문) 또는 `generic:<종류>`. 스냅샷 로그 키는 같은 공개의 release끼리 같으므로
 *   (공개마다 안정된 키), 케이스를 고치거나 새 공개 버전으로 다시 만들어도 같은 로그에서 나온 질문은 같은 키입니다. 답변 메모·공개 선택은 이 키에 붙습니다.
 * - 운영 조치로 가린 항목(T-15)을 가리키는 질문은 만들지 않습니다(`isHidden`).
 */
import {
  type CaseCitation,
  type CaseSectionDraft,
  type CaseSnapshot,
  type CaseSnapshotLog,
  clipText,
  logHeadline,
} from './portfolio'

export const INTERVIEW_QUESTION_CATEGORIES = ['decision', 'conflict', 'stuck', 'failure', 'reflection'] as const
export type InterviewQuestionCategory = (typeof INTERVIEW_QUESTION_CATEGORIES)[number]
export const INTERVIEW_QUESTION_CATEGORY_LABELS: Readonly<Record<InterviewQuestionCategory, string>> = {
  decision: '결정',
  conflict: '협업·의견 충돌',
  stuck: '막힘',
  failure: '실패',
  reflection: '회고',
}

/** 질문 생성 방식. 지금은 template만(AI는 E-12 이후 선택 기능). */
export const INTERVIEW_GENERATORS = ['template'] as const
export type InterviewGenerator = (typeof INTERVIEW_GENERATORS)[number]

/** 근거 있는 질문 수 한도(케이스 하나). 일반 질문(최대 3개)은 따로 붙습니다. */
export const INTERVIEW_SOURCED_QUESTION_LIMIT = 9
/** 답변 메모 최대 길이(글자). */
export const INTERVIEW_NOTE_MAX = 2000
/** 질문 키 최대 길이. */
export const INTERVIEW_QUESTION_KEY_MAX = 100
/** 공개에 남길 수 있는 질문 항목(메모·공개 선택) 수 한도(사용자 × 공개). 지금 만들어지지 않는 질문의 보관 메모를 포함합니다. */
export const INTERVIEW_ENTRY_LIMIT = 100

/** 공개 화면 제목(§10.5). */
export const INTERVIEW_PUBLIC_HEADING = '이 지원자에게 물어보면 좋은 질문'

export interface InterviewQuestionSource {
  kind: 'log'
  key: string
}

export interface InterviewQuestion {
  /** 안정된 질문 키(메모·공개 선택이 붙는 곳). */
  key: string
  category: InterviewQuestionCategory
  text: string
  /** 근거 로그(스냅샷 kind·key). 일반 질문은 null. */
  source: InterviewQuestionSource | null
}

export interface InterviewQuestionInput {
  snapshot: CaseSnapshot
  /** 케이스 문장(인용 포함). 인용한 로그만 질문의 근거가 됩니다. */
  sections: readonly CaseSectionDraft[]
  /** 운영 조치로 가린 항목인지(T-15). 가린 로그에서는 질문을 만들지 않습니다. */
  isHidden?: (kind: CaseCitation['kind'], key: string) => boolean
}

/** 질문 생성기(템플릿 또는 이후의 AI). 결과는 키가 겹치지 않아야 하고, 근거 있는 질문의 source는 입력 스냅샷에 있어야 합니다. */
export type InterviewQuestionGenerator = (input: InterviewQuestionInput) => InterviewQuestion[]

const QUESTION_KEY_RE = /^(decision|hindsight|meeting|stuck):[A-Za-z0-9_-]{1,64}$|^generic:(failure|conflict|retro)$/

/** 저장·요청에 쓸 수 있는 질문 키 모양인지. */
export function isInterviewQuestionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= INTERVIEW_QUESTION_KEY_MAX && QUESTION_KEY_RE.test(value)
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [])

/** 받침 유무로 조사를 고릅니다(한글 음절이 아니면 "을(를)"처럼 둘 다). */
export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const last = [...word.trim()].pop() ?? ''
  const code = last.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? withoutFinal : withFinal
  return `${withFinal}(${withoutFinal})`
}

/** 일반 질문(출처 없음). 팀 과제에만 의견 충돌 질문을 둡니다. */
export const GENERIC_INTERVIEW_QUESTIONS: ReadonlyArray<InterviewQuestion & { teamOnly?: boolean }> = [
  { key: 'generic:failure', category: 'failure', text: '이 프로젝트에서 가장 크게 실패한 것은 무엇이고, 그 뒤 무엇을 바꿨나요?', source: null },
  { key: 'generic:conflict', category: 'conflict', text: '팀 안에서 의견이 부딪힌 적이 있나요? 어떻게 정리했나요?', source: null, teamOnly: true },
  { key: 'generic:retro', category: 'reflection', text: '같은 과제를 다시 한다면 무엇을 다르게 하겠나요?', source: null },
]

/** 케이스 문장이 인용한 로그(처음 나온 순서, 중복 없음, 가린 항목 제외). */
function citedLogs(input: InterviewQuestionInput): CaseSnapshotLog[] {
  const byKey = new Map(input.snapshot.logs.map((l) => [l.key, l]))
  const seen = new Set<string>()
  const out: CaseSnapshotLog[] = []
  for (const section of input.sections) {
    for (const sentence of section.sentences) {
      for (const c of sentence.citations) {
        if (c.kind !== 'log' || seen.has(c.key)) continue
        seen.add(c.key)
        const log = byKey.get(c.key)
        if (!log || input.isHidden?.('log', c.key)) continue
        out.push(log)
      }
    }
  }
  return out
}

/**
 * 템플릿 질문 생성(결정적).
 * - ⚖️결정(인용됨): 선택지가 둘 이상이면 "왜 {다른 선택지} 대신 {선택}을 택했나요?", 아니면 "{선택}을 정할 때 무엇을 가장 중요하게 봤나요?".
 *   "지나고 보니"가 있으면 "지금 다시 정한다면" 질문을 하나 더(키 `hindsight:`).
 * - 회의 정리(인용됨, 결정 사항 있음): 첫 결정 사항을 두고 의견이 갈렸는지(협업·의견 충돌).
 * - 🧱막힘(인용됨): 스냅샷에 해결 로그가 있으면 원인을 찾은 과정, 없으면 지금이라면 어떻게 접근할지.
 * - 근거 있는 질문은 최대 9개, 그 뒤 일반 질문(실패·의견 충돌(팀만)·다시 한다면).
 */
export const generateInterviewQuestions: InterviewQuestionGenerator = (input) => {
  const { snapshot } = input
  const resolved = new Set(snapshot.logs.filter((l) => l.tag === 'solution' && l.resolves).map((l) => l.resolves!))
  const sourced: InterviewQuestion[] = []
  for (const log of citedLogs(input)) {
    const source: InterviewQuestionSource = { kind: 'log', key: log.key }
    if (log.tag === 'decision') {
      const choice = clipText(str(log.payload.choice) || log.body, 60)
      if (!choice) continue
      const alternatives = strList(log.payload.options)
        .map((o) => clipText(o, 40))
        .filter((o) => o && o !== choice)
        .slice(0, 3)
      sourced.push({
        key: `decision:${log.key}`,
        category: 'decision',
        text: alternatives.length
          ? `왜 ${alternatives.join('·')} 대신 ${choice}${josa(choice, '을', '를')} 택했나요?`
          : `${choice}${josa(choice, '을', '를')} 정할 때 무엇을 가장 중요하게 봤나요?`,
        source,
      })
      if (str(log.payload.hindsight).trim()) {
        sourced.push({
          key: `hindsight:${log.key}`,
          category: 'reflection',
          text: `${choice} 결정을 지금 다시 한다면 같은 선택을 할까요? 무엇이 달라졌나요?`,
          source,
        })
      }
    } else if (log.tag === 'meeting') {
      const decided = strList(log.payload.decisions)[0]
      if (!decided) continue
      sourced.push({
        key: `meeting:${log.key}`,
        category: 'conflict',
        text: `회의에서 "${clipText(decided, 60)}"로 정할 때 팀 안에서 의견이 갈렸나요? 어떻게 합의했나요?`,
        source,
      })
    } else if (log.tag === 'stuck') {
      const symptom = clipText(logHeadline(log), 60)
      if (!symptom) continue
      sourced.push({
        key: `stuck:${log.key}`,
        category: 'stuck',
        text: resolved.has(log.key)
          ? `"${symptom}" 문제의 원인을 어떻게 찾았나요? 다시 겪는다면 무엇부터 확인하겠나요?`
          : `"${symptom}" 문제는 기록상 해결되지 않았습니다. 지금이라면 어떻게 접근하겠나요?`,
        source,
      })
    }
  }
  const generic = GENERIC_INTERVIEW_QUESTIONS.filter((q) => !q.teamOnly || snapshot.kind === 'team').map(({ teamOnly: _t, ...q }) => q)
  return [...sourced.slice(0, INTERVIEW_SOURCED_QUESTION_LIMIT), ...generic]
}

/** 기본 생성기(템플릿). AI 생성기는 E-12 이후 이 자리에 선택적으로 붙습니다. */
export const INTERVIEW_TEMPLATE_GENERATOR: { name: InterviewGenerator; generate: InterviewQuestionGenerator } = {
  name: 'template',
  generate: generateInterviewQuestions,
}

export type InterviewNoteCheck = { ok: true; note: string | null } | { ok: false; code: 'invalid' | 'too_long' }

/** 답변 메모: 앞뒤 공백만 정리(줄바꿈 유지), 빈 글은 null(메모 지움), 2000자 한도. */
export function normalizeInterviewNote(raw: unknown): InterviewNoteCheck {
  if (raw === null) return { ok: true, note: null }
  if (typeof raw !== 'string') return { ok: false, code: 'invalid' }
  const note = raw.replace(/\r\n?/g, '\n').trim()
  if (!note) return { ok: true, note: null }
  if ([...note].length > INTERVIEW_NOTE_MAX) return { ok: false, code: 'too_long' }
  return { ok: true, note }
}
