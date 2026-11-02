/**
 * AI 회고 인터뷰 규칙 (E-12, PROOFU_EVOLUTION_PLAN §6.4·§15, DELIVERY_PLAN §4.4, ADR 0057).
 *
 * - 학생이 과제마다 켤 때만(기본 꺼짐). 첫 질문은 고정 문구라 AI를 부르지 않고, 답할 때마다 AI가 다음 질문(꼬리 질문)을 정합니다.
 *   질문은 3개 이상이면 AI가 끝낼 수 있고, 5개에서 반드시 끝납니다. 학생은 언제든 "여기까지 정리"로 끝낼 수 있습니다(답 1개 이상).
 * - 끝나면 AI가 빌드 로그 초안(🔨진행·🧱막힘·⚖️결정·✅검증·🪞회고, 최대 5개)을 구조화 JSON으로 제안합니다. 해결(💡)은 연결할 막힘이,
 *   회의(🗣️)는 참석자가 필요해 초안 태그에서 뺍니다.
 * - 초안은 로그 검증 규칙의 길이·개수 한도에 맞게 자르고, 필수 필드가 비면 버립니다(`aiDraftToLogInput`). 학생이 고친 뒤 승인할 때 서버가
 *   로그 검증을 한 번 더 합니다.
 */
import type { LogTag } from './build-log'

export const AI_RETRO_FIRST_QUESTION = '이번 주 이 과제에서 가장 오래 걸린 건 뭐였어요?'
/** AI가 인터뷰를 끝낼 수 있는 최소 질문 수. */
export const AI_RETRO_MIN_QUESTIONS = 3
/** 이 수만큼 물으면 다음 답 뒤에 반드시 초안으로 넘어갑니다. */
export const AI_RETRO_MAX_QUESTIONS = 5
export const AI_RETRO_ANSWER_MAX = 1000
export const AI_RETRO_QUESTION_MAX = 300
export const AI_RETRO_MAX_DRAFTS = 5
/** 세션(질문·답변·초안) 최대 보존: 만든 지 7일. */
export const AI_RETRO_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 프롬프트 맥락으로 보내는 "내 최근 로그" 수(제목 격인 한 줄 요약과 태그만). */
export const AI_RETRO_CONTEXT_LOGS = 5

export const AI_RETRO_DRAFT_TAGS = ['progress', 'stuck', 'decision', 'validation', 'retro'] as const satisfies readonly LogTag[]
export type AiRetroDraftTag = (typeof AI_RETRO_DRAFT_TAGS)[number]

const STUCK_TIME_BUCKETS = ['lt30m', 'lt2h', 'half_day', 'day_plus'] as const

/** 답 하나를 받은 뒤 다음 단계: 더 묻기 또는 초안 만들기. `questionCount`는 지금까지 한 질문 수(방금 답한 질문 포함). */
export function nextInterviewStep(questionCount: number, modelWantsToFinish: boolean): 'ask' | 'draft' {
  if (questionCount >= AI_RETRO_MAX_QUESTIONS) return 'draft'
  if (modelWantsToFinish && questionCount >= AI_RETRO_MIN_QUESTIONS) return 'draft'
  return 'ask'
}

/** 모델이 내는 초안 한 개(구조화 출력 스키마와 같은 모양, snake_case). */
export interface AiDraftRaw {
  tag: string
  body: string
  stuck: { symptom: string; keywords: string[]; attempts: string[]; time_bucket: string } | null
  decision: { options: string[]; criteria: string; choice: string; hindsight: string | null } | null
  validation: { target: string; conditions: string; result: string; open_questions: string | null } | null
}

export interface AiDraftLogInput {
  tag: AiRetroDraftTag
  body: string
  payload: Record<string, unknown>
}

const clean = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max).trim() : text
}

const cleanList = (values: unknown, itemMax: number, countMax: number): string[] => {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const v of values) {
    const text = clean(v, itemMax)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= countMax) break
  }
  return out
}

/**
 * 모델 초안 → 로그 작성 입력(tag·body·payload). 로그 검증 한도(본문 5000자, 증상 200자, 키워드 10×40자, 시도 10×500자,
 * 선택지 2~6×200자, 기준 1000자, 선택 200자, 돌아보면 2000자, 검증 필드 1000자)에 맞게 자르고, 필수 필드가 비면 null(그 초안은 버림).
 * 🧱막힘의 "과제 답 아님" 확인(answerCheck)은 학생이 직접 하도록 늘 false로 둡니다.
 */
export function aiDraftToLogInput(raw: AiDraftRaw): AiDraftLogInput | null {
  if (!(AI_RETRO_DRAFT_TAGS as readonly string[]).includes(raw.tag)) return null
  const tag = raw.tag as AiRetroDraftTag
  const body = typeof raw.body === 'string' ? raw.body.trim().slice(0, 5000).trim() : ''
  switch (tag) {
    case 'progress':
    case 'retro':
      return body ? { tag, body, payload: {} } : null
    case 'stuck': {
      const symptom = clean(raw.stuck?.symptom, 200)
      const timeBucket = (STUCK_TIME_BUCKETS as readonly string[]).includes(raw.stuck?.time_bucket ?? '') ? raw.stuck!.time_bucket : 'lt2h'
      if (!symptom) return null
      return {
        tag,
        body,
        payload: {
          symptom,
          keywords: cleanList(raw.stuck?.keywords, 40, 10),
          attempts: cleanList(raw.stuck?.attempts, 500, 10),
          timeBucket,
          answerCheck: false,
        },
      }
    }
    case 'decision': {
      const options = cleanList(raw.decision?.options, 200, 6)
      const criteria = clean(raw.decision?.criteria, 1000)
      const choice = clean(raw.decision?.choice, 200)
      if (options.length < 2 || !criteria || !choice) return null
      const hindsight = clean(raw.decision?.hindsight, 2000)
      return { tag, body, payload: { options, criteria, choice, ...(hindsight && { hindsight }) } }
    }
    case 'validation': {
      const target = clean(raw.validation?.target, 1000)
      const conditions = clean(raw.validation?.conditions, 1000)
      const result = clean(raw.validation?.result, 1000)
      if (!target || !conditions || !result) return null
      const openQuestions = clean(raw.validation?.open_questions, 1000)
      return { tag, body, payload: { target, conditions, result, ...(openQuestions && { openQuestions }) } }
    }
  }
}

/** 프롬프트에 넣는 학생 글에서 구획 태그를 깨는 문자열을 무력화합니다(`</answer>` 같은 닫는 태그로 지시를 끼워 넣지 못하게). */
export function neutralizePromptText(text: string): string {
  return text.replace(/<\s*\//g, '< /').replace(/\u0000/g, '')
}
