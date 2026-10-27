import { listMyOfficialRequests } from '../../../../modules/community/official'

/** GET /api/v1/community/official-requests — 내 공식 페이지 개설 요청(요청 수 없음). */
export default defineApiHandler(async (event) => listMyOfficialRequests(requireDb(), requireActor(event)))
