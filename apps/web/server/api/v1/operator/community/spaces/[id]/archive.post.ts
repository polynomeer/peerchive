import { archiveSpaceByOperator } from '../../../../../../modules/community/official'

/** POST /api/v1/operator/community/spaces/:id/archive {note} — 운영자 보관. 409 already_archived. */
export default defineApiHandler(async (event) => archiveSpaceByOperator(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
