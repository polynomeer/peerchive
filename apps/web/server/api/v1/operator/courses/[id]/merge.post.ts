import { mergeCourse } from '../../../../../modules/catalog/merge'

/** POST /api/v1/operator/courses/:id/merge {into} — 운영자만(403). 다른 학교 409 different_school. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return mergeCourse(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
