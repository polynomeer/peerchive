import { getAiRetroState } from '../../../../../modules/ai/retro-interview'

/** GET /api/v1/projects/:id/ai-retro — AI 회고 인터뷰 상태(본인: 켬 여부·진행 중 세션·초안). AI 공급자가 없으면 404(E-12, ADR 0057). */
export default defineApiHandler((event) => getAiRetroState(requireDb(), requireActor(event), getRouterParam(event, 'id')))
