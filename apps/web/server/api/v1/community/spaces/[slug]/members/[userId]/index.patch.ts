import { changeMemberRole } from '../../../../../../../modules/community/memberships'

/** PATCH /api/v1/community/spaces/:slug/members/:userId {role} — owner만. role owner는 소유권 이전. */
export default defineApiHandler(async (event) => changeMemberRole(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'userId'), await readJsonBody(event)))
