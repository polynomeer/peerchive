import { createOfficialPage } from '../../../../../modules/community/official'

/** POST /api/v1/operator/community/official-pages {schoolId, departmentLabel?, name?, description?} — 공식 페이지 개설(운영자만). 201. 409 official_exists. */
export default defineApiHandler(async (event) => {
  const result = await createOfficialPage(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
