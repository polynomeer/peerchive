import { listSanctions } from '../../../../../modules/community/moderation'

/** GET /api/v1/operator/community/sanctions?status=active|all — 제재 목록(대상자 없음). 운영자만. */
export default defineApiHandler(async (event) => listSanctions(requireDb(), requireActor(event), getQuery(event)))
