/**
 * AI 회고 인터뷰(E-12, ADR 0057) 화면 도우미: 초안 → 빌드 로그 입력 폼, 오류 문구.
 */
import type { AiRetroDraftDto, DecisionPayload, StuckPayload, ValidationPayload } from '~~/shared/types/api'
import { type LogForm, emptyLogForm } from './build-log'

/** 초안을 빌드 로그 입력 폼(LogFields)으로. 학생이 고친 뒤 승인합니다. */
export function aiDraftToForm(draft: AiRetroDraftDto): LogForm {
  const form = emptyLogForm(draft.tag)
  form.body = draft.body
  if (draft.tag === 'stuck') {
    const s = draft.payload as StuckPayload
    Object.assign(form, {
      symptom: s.symptom,
      keywords: s.keywords.join(', '),
      errorText: s.errorText ?? '',
      attempts: s.attempts.join('\n'),
      timeBucket: s.timeBucket,
      answerCheck: false,
    })
  } else if (draft.tag === 'decision') {
    const d = draft.payload as DecisionPayload
    Object.assign(form, { options: d.options.join('\n'), criteria: d.criteria, choice: d.choice, hindsight: d.hindsight ?? '' })
  } else if (draft.tag === 'validation') {
    const v = draft.payload as ValidationPayload
    Object.assign(form, { target: v.target, conditions: v.conditions, result: v.result, openQuestions: v.openQuestions ?? '' })
  }
  return form
}

/** AI 경로 오류 문구. 폼 체크인은 AI와 무관하게 늘 쓸 수 있다는 안내를 붙입니다. */
export function aiRetroErrorMessage(status: number, code: string): string {
  if (status === 429) return '오늘 AI 사용 한도를 넘었습니다. 내일 다시 시도하거나 위의 폼 체크인으로 남기세요.'
  if (status === 503 && code === 'ai_declined') return 'AI가 이 내용으로는 답하지 않았습니다. 표현을 바꿔 다시 시도하거나 폼 체크인·빌드 로그로 직접 남기세요.'
  if (status === 503) return 'AI가 지금 답하지 못했습니다. 입력은 남아 있으니 잠시 뒤 다시 시도하거나 폼 체크인을 쓰세요.'
  if (status === 409 && code === 'stale_question') return '다른 창에서 먼저 답해 최신 상태를 불러왔습니다.'
  if (status === 409 && code === 'drafts_pending') return '먼저 남은 초안을 승인하거나 버리세요.'
  if (status === 403 && code === 'ai_opt_in_required') return '이 과제에서 AI 회고 인터뷰를 먼저 켜세요.'
  if (status === 403) return '편집 권한이 있어야 쓸 수 있습니다.'
  if (status === 404) return '인터뷰를 찾을 수 없습니다. 끝났거나 7일이 지나 지워졌을 수 있습니다.'
  return '처리하지 못했습니다. 다시 시도하세요.'
}
