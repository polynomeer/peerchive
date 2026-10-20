import { addProjectEmbargo } from '../../../../modules/embargo/embargo'

/** POST /api/v1/projects/:id/embargoes {until, reason} — owner만(403, 비멤버 404). 201 + 적용 엠바고. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const embargo = await addProjectEmbargo(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return embargo
})
