import { reverseSpaceHide } from '../../../../../../modules/community/moderation'

/** POST /api/v1/operator/community/space-hides/:id/reverse {note} — 운영자가 방 운영진 가리기를 되돌림. 409 already_reversed. */
export default defineApiHandler(async (event) => reverseSpaceHide(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
