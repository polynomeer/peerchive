import { requestOfficialPage } from '../../../../modules/community/official'

/**
 * POST /api/v1/community/official-requests {schoolId, departmentLabel?} — 공식 페이지 개설 요청(그 학교 인증 필요).
 * 201(새 요청) / 200(이미 요청함, created: false). 403 affiliation_required, 409 official_exists, 422. 요청 수는 운영자에게만.
 */
export default defineApiHandler(async (event) => {
  const result = await requestOfficialPage(requireDb(), requireActor(event), await readJsonBody(event))
  if (result.created) setResponseStatus(event, 201)
  return result
})
