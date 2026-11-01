import { grantCourseCurator } from '../../../../../../modules/curators/assignments'

/**
 * POST /api/v1/operator/courses/:id/curators {userId} — 운영자만(E-03). 201 + 그 과목의 큐레이터 목록. 자격: 과목을 마침 + 그 학교 active 학교 인증,
 * 과목당 2명. 422 `userId: not_found|inactive|not_finished|not_verified`, 409 `already_curator|limit_reached`. 감사 id만.
 */
export default defineApiHandler(async (event) => {
  const result = await grantCourseCurator(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
