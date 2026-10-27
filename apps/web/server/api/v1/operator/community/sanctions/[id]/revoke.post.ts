import { revokeSanction } from '../../../../../../modules/community/moderation'

/** POST /api/v1/operator/community/sanctions/:id/revoke {note} — 제재 해제. 409 already_revoked. 운영자만. */
export default defineApiHandler(async (event) => revokeSanction(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
