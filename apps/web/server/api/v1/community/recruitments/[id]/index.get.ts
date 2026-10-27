import { getRecruitment } from '../../../../../modules/community/recruitments'

/** GET /api/v1/community/recruitments/:id — 모집 상세(모집자에게는 지원 수·결과 링크). 200, 404. */
export default defineApiHandler(async (event) => getRecruitment(requireDb(), requireActor(event), getRouterParam(event, 'id')))
