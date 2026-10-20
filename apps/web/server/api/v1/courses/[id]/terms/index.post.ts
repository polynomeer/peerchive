import { createCourseTerm } from '../../../../../modules/catalog/catalog'

/**
 * POST /api/v1/courses/:id/terms {year, semester} — 새로 만들면 201, 이미 있으면 200(created=false).
 * 종료 시각은 서버가 계산합니다(endsAt을 보내면 422).
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await createCourseTerm(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, result.created ? 201 : 200)
  return result
})
