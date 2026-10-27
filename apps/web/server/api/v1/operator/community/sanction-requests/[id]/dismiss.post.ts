import { dismissSanctionRequest } from '../../../../../../modules/community/moderation'

/** POST /api/v1/operator/community/sanction-requests/:id/dismiss {note} — 제재 없이 닫기. 409 already_closed. 운영자만. */
export default defineApiHandler(async (event) => dismissSanctionRequest(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
