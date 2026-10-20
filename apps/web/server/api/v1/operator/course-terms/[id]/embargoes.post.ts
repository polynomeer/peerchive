import { addCourseTermEmbargo } from '../../../../../modules/embargo/embargo'

/** POST /api/v1/operator/course-terms/:id/embargoes {until, reason} — 운영자만(403). 201. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await addCourseTermEmbargo(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
