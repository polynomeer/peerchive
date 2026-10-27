import { approveMember } from '../../../../../../../modules/community/memberships'

/** POST /api/v1/community/spaces/:slug/members/:userId/approve — owner·admin. 409 not_pending·space_full. */
export default defineApiHandler(async (event) => approveMember(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'userId')))
