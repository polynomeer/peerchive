import { withdrawApplication } from '../../../../../modules/community/recruitments'

/** POST /api/v1/community/recruitments/:id/withdraw — 내 지원 취소(모집 중). 200, 404, 409 not_applied·recruitment_not_open·not_withdrawable. */
export default defineApiHandler(async (event) => withdrawApplication(requireDb(), requireActor(event), getRouterParam(event, 'id')))
