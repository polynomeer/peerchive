import { acceptInvitation } from '../../../modules/projects/invitations'

/**
 * POST /api/v1/invitations/accept {token}
 * 만료·사용·취소·없는 초대는 모두 같은 410, 이미 멤버면 409.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return acceptInvitation(requireDb(), actor, await readJsonBody(event))
})
