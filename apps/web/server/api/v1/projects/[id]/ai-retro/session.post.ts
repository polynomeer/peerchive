import { startAiRetroSession } from '../../../../../modules/ai/retro-interview'

/** POST /api/v1/projects/:id/ai-retro/session — 인터뷰 시작(첫 질문은 고정). 켜지 않았으면 403 ai_opt_in_required, 처리하지 않은 초안이 있으면 409 drafts_pending. */
export default defineApiHandler((event) => startAiRetroSession(requireDb(), requireActor(event), getRouterParam(event, 'id')))
