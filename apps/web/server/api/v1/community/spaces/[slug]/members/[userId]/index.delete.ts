import { removeMember } from '../../../../../../../modules/community/memberships'

/** DELETE /api/v1/community/spaces/:slug/members/:userId — 내보내기(owner: owner 말고 모두, admin: moderator·member). */
export default defineApiHandler(async (event) => removeMember(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'userId')))
