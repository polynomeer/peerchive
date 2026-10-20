import { getCandidate } from '../../../../modules/publication/candidates'

/** GET /api/v1/candidates/:id — 멤버 또는 동의 당사자. ready 여부를 다시 계산하고 blockers를 함께 줍니다. 그 밖에는 404. */
export default defineApiHandler(async (event) => getCandidate(requireDb(), requireActor(event), getRouterParam(event, 'id')))
