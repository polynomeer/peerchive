import { readCommunityWriteBody } from '../../../../modules/community/http'
import { createSanctionRequest } from '../../../../modules/community/moderation'

/**
 * POST /api/v1/community/sanction-requests {targetType: post|comment, targetId, reason, details} — 방 운영진의 제재 요청(C-06, 작성자를 모른 채).
 * 새 요청 201, 같은 대상의 처리 전 요청이 있으면 200(created false). 403 moderate_not_allowed, 404, 422, 429.
 */
export default defineApiHandler(async (event) => {
  const result = await createSanctionRequest(requireDb(), requireActor(event), await readCommunityWriteBody(event))
  setResponseStatus(event, result.created ? 201 : 200)
  return result
})
