import { createCandidate } from '../../../../../modules/publication/candidates'

/**
 * POST /api/v1/projects/:id/publication-candidates — 공개 후보 만들기(active owner/editor). 201 + 후보.
 * reviewer/viewer 403, 비멤버 404, 엠바고 409 embargo_active(+until), 선택 오류 422(not_found/not_clean/not_allowed/taken/reserved).
 * 열린 이전 후보는 superseded가 됩니다. 게시는 T-12입니다.
 */
export default defineApiHandler(async (event) => {
  const candidate = await createCandidate(
    requireDb(),
    requireActor(event),
    getRouterParam(event, 'id'),
    await readJsonBody(event),
    new Date(),
    { privateOrigins: siteOrigins() },
  )
  setResponseStatus(event, 201)
  return candidate
})
