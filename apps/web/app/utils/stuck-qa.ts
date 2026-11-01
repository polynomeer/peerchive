/**
 * 막힘 Q&A 스레드 화면 문구(E-04, ADR 0049).
 */
export const STUCK_QA_ERROR_MESSAGES: Record<string, string> = {
  unauthenticated: '로그인이 필요합니다.',
  hub_write_not_allowed: '이 과목 학교 메일로 인증하면 질문·답변을 쓸 수 있습니다.',
  questions_closed: '막힘 로그 작성자가 질문 받기를 꺼 두었습니다.',
  course_not_linked: '과목 허브에 연결된 공개 사례에서만 질문을 받을 수 있습니다.',
  not_log_author: '이 막힘 로그를 쓴 사람만 바꿀 수 있습니다.',
  rate_limited: '잠시 뒤 다시 시도하세요(요청이 너무 많습니다).',
  not_found: '찾을 수 없습니다. 공개가 철회되었거나 스레드가 닫혔을 수 있습니다.',
  validation_failed: '입력을 확인하세요(1~2000자).',
}

export function stuckQaErrorMessage(code: string, fields: Record<string, string> = {}): string {
  if (fields.card === 'own_card') return '내 막힘 로그에는 질문을 열 수 없습니다. 열린 스레드에 작성자로 답할 수 있습니다.'
  if (fields.post === 'own_post') return '내 글에는 "도움됐어요"를 누를 수 없습니다.'
  return STUCK_QA_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}

export const STUCK_QA_GUIDE =
  '원리·접근 위주로 묻고 답해 주세요. 진행 중인 과제를 대신 풀어 주거나 답을 사고파는 글은 신고 대상입니다. 스레드에서는 모두 익명(질문자·익명N)이고 막힘 로그를 쓴 사람은 작성자로 보입니다.'
