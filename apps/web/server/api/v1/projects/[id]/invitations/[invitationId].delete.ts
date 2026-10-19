import { revokeInvitation } from '../../../../../modules/projects/invitations'

/** DELETE /api/v1/projects/:id/invitations/:invitationId — owner가 초대를 취소합니다. */
export default defineApiHandler((event) =>
  revokeInvitation(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'invitationId')),
)
