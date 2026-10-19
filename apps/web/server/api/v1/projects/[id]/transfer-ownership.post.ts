import { transferOwnership } from '../../../../modules/projects/members'

/** POST /api/v1/projects/:id/transfer-ownership {userId} — owner → 다른 active 멤버. 이전 owner는 editor. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  await transferOwnership(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 204)
  return null
})
