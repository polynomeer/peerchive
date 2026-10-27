import { readCommunityWriteBody } from '../../../../../../modules/community/http'
import { applyToRecruitment } from '../../../../../../modules/community/recruitments'

/**
 * POST /api/v1/community/recruitments/:id/applications {message?, attachProfile?, caseSlugs?} — 지원(C-07). 201 내 지원.
 * 403 own_recruitment·write_restricted, 404, 409 recruitment_not_open·already_applied, 413, 422, 429(하루 20번).
 */
export default defineApiHandler(async (event) => {
  const result = await applyToRecruitment(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event))
  setResponseStatus(event, 201)
  return result
})
