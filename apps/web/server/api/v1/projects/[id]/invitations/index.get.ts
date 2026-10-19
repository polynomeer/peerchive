import { listInvitations } from '../../../../../modules/projects/invitations'

/** GET /api/v1/projects/:id/invitations — owner만. 토큰은 포함하지 않습니다. */
export default defineApiHandler((event) => listInvitations(requireDb(), requireActor(event), getRouterParam(event, 'id')))
