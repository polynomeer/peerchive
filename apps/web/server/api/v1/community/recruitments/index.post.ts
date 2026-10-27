import { readCommunityWriteBody } from '../../../../modules/community/http'
import { createRecruitment } from '../../../../modules/community/recruitments'

/**
 * POST /api/v1/community/recruitments {kind, spaceSlug?, courseId?, termId?, title, description?, capacity, closesAt?, roomNameMode?} — 모집 글(C-07).
 * 201 상세. 403 affiliation_required·write_not_allowed·write_restricted, 404, 409 no_recruiting_board·team_finding_disabled, 413, 422, 429(하루 5개).
 */
export default defineApiHandler(async (event) => {
  const result = await createRecruitment(requireDb(), requireActor(event), await readCommunityWriteBody(event))
  setResponseStatus(event, 201)
  return result
})
