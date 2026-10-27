import { liftSpaceRestriction } from '../../../../../../modules/community/official'

/** POST /api/v1/operator/community/spaces/:id/lift-restriction {note} — 제한 해제. 409 not_restricted. */
export default defineApiHandler(async (event) => liftSpaceRestriction(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
