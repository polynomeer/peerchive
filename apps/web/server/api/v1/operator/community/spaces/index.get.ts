import { listSpacesForOperator } from '../../../../../modules/community/official'

/** GET /api/v1/operator/community/spaces?kind=&status=&capacityRequested=1&schoolId= — 운영자만. 공간 정보만(게시판·멤버 없음). */
export default defineApiHandler(async (event) => listSpacesForOperator(requireDb(), requireActor(event), getQuery(event)))
