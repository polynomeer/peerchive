import { listSpaceInvitations } from '../../../../../../modules/community/invitations'

/** GET /api/v1/community/spaces/:slug/invitations — owner·admin. 원문 링크는 다시 보이지 않습니다. */
export default defineApiHandler(async (event) => listSpaceInvitations(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
