import { addCourseTag } from '../../../../../modules/catalog/tags'

/** POST /api/v1/courses/:id/concept-tags {tagId} | {label} — 새로 붙이면 201, 이미 있으면 200. 12개 초과 409 limit_reached. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await addCourseTag(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, result.added ? 201 : 200)
  return result
})
