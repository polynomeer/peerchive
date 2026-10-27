import { revokeSpaceInvitation } from '../../../../../../modules/community/invitations'

/** DELETE /api/v1/community/spaces/:slug/invitations/:id — 초대 취소(owner·admin). */
export default defineApiHandler(async (event) => revokeSpaceInvitation(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id')))
