import { rejectMember } from '../../../../../../../modules/community/memberships'

/** POST /api/v1/community/spaces/:slug/members/:userId/reject — owner·admin. 거절은 removed(새 초대로만 다시 들어옴). */
export default defineApiHandler(async (event) => rejectMember(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'userId')))
