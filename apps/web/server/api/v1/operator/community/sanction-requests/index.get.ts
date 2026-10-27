import { listSanctionRequests } from '../../../../../modules/community/moderation'

/** GET /api/v1/operator/community/sanction-requests?status=open|resolved|dismissed — 방 운영진의 제재 요청(작성자 없음). 운영자만. */
export default defineApiHandler(async (event) => listSanctionRequests(requireDb(), requireActor(event), getQuery(event)))
