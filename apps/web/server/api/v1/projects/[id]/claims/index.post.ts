import { createClaim } from '../../../../../modules/contribution/claims'

/**
 * POST /api/v1/projects/:id/claims {text, evidence?[{kind:'log'|'artifact', id}]} — 본인 선언(owner/editor/reviewer). 201.
 * viewer 403, 멤버당 10개 초과 409 limit_reached, 근거 422 not_found/not_attachable.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const claim = await createClaim(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return claim
})
