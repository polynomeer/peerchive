import { issueSanction } from '../../../../../modules/community/moderation'

/**
 * POST /api/v1/operator/community/sanctions {lookupId, level: warning|write_suspended|permanent, scope: community|space, days?, note, publicReason} — 운영자만.
 * 201. 404(조회 기록), 409 lookup_not_yours·lookup_expired·author_unavailable, 422(days: required|not_allowed|too_long, scope: community_only).
 */
export default defineApiHandler(async (event) => {
  const result = await issueSanction(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
