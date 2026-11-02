import { answerAiRetro } from '../../../../../modules/ai/retro-interview'

/**
 * POST /api/v1/projects/:id/ai-retro/answers {questionNo, answer?, finish?} — 답하기 또는 "여기까지 정리".
 * AI가 다음 질문을 정하거나 초안을 만듭니다. 409 stale_question(다른 탭에서 먼저 답함), 429(하루 한도), 503 ai_unavailable·ai_declined.
 */
export default defineApiHandler(async (event) =>
  answerAiRetro(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
