import { createCourse } from '../../../../../modules/catalog/catalog'

/** POST /api/v1/schools/:id/courses {title, code?, confirmNew?} — 201. 409 already_exists / similar_exists, 한도 429. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const course = await createCourse(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return course
})
