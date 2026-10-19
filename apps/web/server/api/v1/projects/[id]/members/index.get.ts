import { listMembers } from '../../../../../modules/projects/members'

/** GET /api/v1/projects/:id/members — active 멤버만. */
export default defineApiHandler((event) => listMembers(requireDb(), requireActor(event), getRouterParam(event, 'id')))
