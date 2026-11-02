import { getAiMeetingState } from '../../../../../modules/ai/meeting-summary'

/** GET /api/v1/projects/:id/ai-meetings — 회의 채널·멤버 동의 현황·승인 전 회의 요약 초안(멤버). AI 공급자가 없으면 404(E-13, ADR 0058). */
export default defineApiHandler((event) => getAiMeetingState(requireDb(), requireActor(event), getRouterParam(event, 'id')))
