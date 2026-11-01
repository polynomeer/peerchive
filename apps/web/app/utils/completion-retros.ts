/**
 * 수료 회고 화면 도우미(A-06, ADR 0043). 질문·표시 방식 글자는 @peerchive/domain 값을 그대로 씁니다. 별점·연봉·추천 점수 입력은 없습니다.
 */
import {
  ANONYMOUS_RETRO_LABEL,
  COMPLETION_RETRO_ANSWER_MAX,
  COMPLETION_RETRO_DISPLAY_LABELS,
  COMPLETION_RETRO_QUESTIONS,
  COMPLETION_RETRO_QUESTION_LABELS,
} from '@peerchive/domain'

export { ANONYMOUS_RETRO_LABEL, COMPLETION_RETRO_ANSWER_MAX, COMPLETION_RETRO_DISPLAY_LABELS, COMPLETION_RETRO_QUESTIONS, COMPLETION_RETRO_QUESTION_LABELS }

const RETRO_ERROR_MESSAGES: Record<string, string> = {
  retro_exists: '이 기관에 이미 쓴 회고가 있습니다. 내 회고에서 철회한 뒤 다시 쓸 수 있습니다.',
  checks_unconfirmed: '공개 전 점검 경고가 있습니다. 내용을 확인하고 그대로 올릴지 고르세요.',
  display_persona_required: '표시명으로 쓰려면 먼저 표시명 프로필을 만드세요.',
  rate_limited: '잠시 뒤 다시 시도하세요.',
  not_found: '찾을 수 없습니다.',
}

export function retroErrorMessage(code: string): string {
  return RETRO_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}
