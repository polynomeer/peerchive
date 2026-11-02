import { discardCasePolish } from '../../../../../modules/ai/case-polish'

/** DELETE /api/v1/case-studies/:id/ai-polish — 다듬기 제안 전체 버리기(케이스는 그대로, E-14). 409 no_proposal. */
export default defineApiHandler((event) => discardCasePolish(requireDb(), requireActor(event), getRouterParam(event, 'id')))
