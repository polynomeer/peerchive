import { getCasePolishState } from '../../../../../modules/ai/case-polish'

/** GET /api/v1/case-studies/:id/ai-polish — AI 다듬기 제안 상태(케이스 주인만, AI가 꺼져 있으면 404, E-14). */
export default defineApiHandler((event) => getCasePolishState(requireDb(), requireActor(event), getRouterParam(event, 'id')))
