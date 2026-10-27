import { listMembers } from '../../../../../../modules/community/memberships'

/** GET /api/v1/community/spaces/:slug/members — owner·admin만(403). 공식 페이지는 409 no_member_list. */
export default defineApiHandler(async (event) => listMembers(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
