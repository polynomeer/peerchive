import { discardAiRetroSession } from '../../../../../modules/ai/retro-interview'

/** DELETE /api/v1/projects/:id/ai-retro/session — 진행 중 인터뷰와 초안을 모두 버림(로그를 쓰지 않음). */
export default defineApiHandler((event) => discardAiRetroSession(requireDb(), requireActor(event), getRouterParam(event, 'id')))
