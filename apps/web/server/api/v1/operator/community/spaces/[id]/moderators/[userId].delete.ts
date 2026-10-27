import { unassignModerator } from '../../../../../../../modules/community/official'

/** DELETE /api/v1/operator/community/spaces/:id/moderators/:userId — 모더레이터 해제. */
export default defineApiHandler(async (event) => unassignModerator(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'userId')))
