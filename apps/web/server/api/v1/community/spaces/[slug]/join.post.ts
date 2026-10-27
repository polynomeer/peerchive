import { joinSpace } from '../../../../../modules/community/memberships'

/** POST /api/v1/community/spaces/:slug/join — open → active, approval → pending. 403 invite_only·removed, 409 already_member·already_pending·space_full·not_joinable, 404. */
export default defineApiHandler(async (event) => joinSpace(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
