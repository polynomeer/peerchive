/**
 * 수료 회고 규칙 (A-06, PROOFU_EVOLUTION_PLAN §8.9.10 "가져오지 않는 것"·§8.9.11, SYSTEM_DESIGN §6.7.2 "수료 회고", DELIVERY_PLAN §4.3 A-06, ADR 0043).
 *
 * - 부트캠프·교육 프로그램·동아리 연합(대학이 아닌 기관)을 **수료한** 사람(standing alumni의 active 인증 소속)이 그 기관에 남기는 구조화된 회고입니다.
 *   선배 노트처럼 질문별 답(각 1000자, 2개 이상)이고, **별점·연봉·추천 점수 같은 평가 필드는 없습니다**(완료 기준). 질문 키에도 그런 값이 없고,
 *   입력에 다른 키(예: `rating`·`salary`·`score`)가 오면 거부합니다(`answers.<key>: unknown`).
 * - 이름 표시: 계정 이름(name) / 표시명 페르소나 이름(display) / 익명(anonymous, "익명 수료생"). 페르소나로 투영하지 않습니다.
 * - 기관 표시(A-05 규칙 재사용): 익명 회고는 작성자가 고른 범위(기관 이름/기관 유형/표시 안 함)에 쓰는 순간의 인증 수료생 수로 임계값을 적용해
 *   고정합니다(@peerchive/domain decideAffiliationLabel). 기관 이름이 아닌 범위로 정해지면 그 기관 목록에 나오지 않습니다(기관 이름이 익명을 깨뜨리지
 *   않게). 이름을 건 회고는 기관 이름 범위로 고정합니다(이름으로 이미 드러나므로 숨길 익명이 없음).
 * - 기수: 이름을 건 회고에서 작성자가 고른 경우만 보입니다(`showCohort`). 익명 회고는 기수를 보이지 않습니다(학과·기수·입학연도 미표시 원칙, A-05).
 *
 * 런타임 의존성 없음.
 */

/** 질문 4개(선배 노트 형식): 배운 것 / 과정(커리큘럼·진행 방식)을 지나며 겪은 것 / 시작 전에 알았으면 좋았을 것 / 다음 수강생에게. */
export const COMPLETION_RETRO_QUESTIONS = ['learned', 'curriculum', 'beforeStart', 'advice'] as const
export type CompletionRetroQuestion = (typeof COMPLETION_RETRO_QUESTIONS)[number]
export type CompletionRetroAnswers = Partial<Record<CompletionRetroQuestion, string>>

export const COMPLETION_RETRO_QUESTION_LABELS: Readonly<Record<CompletionRetroQuestion, string>> = {
  learned: '과정에서 실제로 배운 것',
  curriculum: '커리큘럼·진행 방식을 지나며 겪은 것',
  beforeStart: '시작 전에 알았으면 좋았을 것',
  advice: '다음 수강생에게 하고 싶은 말',
}

export const COMPLETION_RETRO_ANSWER_MAX = 1000
export const COMPLETION_RETRO_MIN_ANSWERS = 2

/**
 * 두지 않는 평가 필드의 낱말(완료 기준 "별점·연봉·추천 점수 필드 없음"). 스키마 테스트가 표 열 이름과 질문 키를 낱말로 나눠(snake_case·camelCase)
 * 이 낱말이 없음을 확인합니다. 입력에 이런 키가 오면 다른 모르는 키와 같이 거부합니다.
 */
export const COMPLETION_RETRO_FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
  'rating',
  'ratings',
  'rate',
  'star',
  'stars',
  'score',
  'scores',
  'salary',
  'wage',
  'wages',
  'pay',
  'income',
  'compensation',
  'recommend',
  'recommendation',
  'nps',
  'grade',
])

/** 필드 이름이 평가 필드 낱말을 담는지(`star_rating`·`salaryRange`·`nps` → true, `beforeStart` → false). */
export function isEvaluationFieldName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
  return words.some((w) => COMPLETION_RETRO_FORBIDDEN_WORDS.has(w))
}

export const COMPLETION_RETRO_DISPLAY_MODES = ['name', 'display', 'anonymous'] as const
export type CompletionRetroDisplayMode = (typeof COMPLETION_RETRO_DISPLAY_MODES)[number]
export const COMPLETION_RETRO_DISPLAY_LABELS: Readonly<Record<CompletionRetroDisplayMode, string>> = {
  name: '계정 이름',
  display: '표시명',
  anonymous: '익명',
}
export const ANONYMOUS_RETRO_LABEL = '익명 수료생'

export const COMPLETION_RETRO_STATUSES = ['published', 'withdrawn', 'hidden'] as const
export type CompletionRetroStatus = (typeof COMPLETION_RETRO_STATUSES)[number]

/** 목록 한 쪽 크기. */
export const COMPLETION_RETRO_PAGE_SIZE = 20

/** 작성 안내(필수 확인 문구). */
export const COMPLETION_RETRO_GUIDELINE =
  '강사·운영진 개인에 대한 평가, 별점·연봉·추천 점수, 다른 수강생의 개인정보를 넣지 않았습니다. 경험과 배운 점을 남깁니다.'

export type CompletionRetroAnswersCheck =
  | { ok: true; answers: CompletionRetroAnswers }
  | { ok: false; fields: Record<string, string> }

/** 답 정규화: 알려진 질문 키만(그 밖은 `answers.<key>: unknown`), 문자열, 앞뒤 공백 정리, 각 1000자, 비어 있지 않은 답 2개 이상. */
export function normalizeCompletionRetroAnswers(raw: unknown): CompletionRetroAnswersCheck {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, fields: { answers: 'invalid' } }
  const answers: CompletionRetroAnswers = {}
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(COMPLETION_RETRO_QUESTIONS as readonly string[]).includes(key)) {
      fields[`answers.${key}`] = 'unknown'
      continue
    }
    if (value === null || value === undefined) continue
    if (typeof value !== 'string') {
      fields[`answers.${key}`] = 'invalid'
      continue
    }
    const text = value.replace(/\r\n?/g, '\n').trim()
    if (!text) continue
    if ([...text].length > COMPLETION_RETRO_ANSWER_MAX) {
      fields[`answers.${key}`] = 'too_long'
      continue
    }
    answers[key as CompletionRetroQuestion] = text
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields }
  if (Object.keys(answers).length < COMPLETION_RETRO_MIN_ANSWERS) return { ok: false, fields: { answers: 'too_few' } }
  const ordered: CompletionRetroAnswers = {}
  for (const q of COMPLETION_RETRO_QUESTIONS) if (answers[q]) ordered[q] = answers[q]
  return { ok: true, answers: ordered }
}

/** 공개 작성자 표시. 익명은 항상 "익명 수료생". */
export function completionRetroAuthorLabel(mode: CompletionRetroDisplayMode, displayNameSnapshot: string | null): string {
  if (mode === 'anonymous') return ANONYMOUS_RETRO_LABEL
  return displayNameSnapshot?.trim() || ANONYMOUS_RETRO_LABEL
}
