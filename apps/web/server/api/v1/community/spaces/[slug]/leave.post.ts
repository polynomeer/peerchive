import { leaveSpace } from '../../../../../modules/community/memberships'

/** POST /api/v1/community/spaces/:slug/leave — 나가기(승인 대기면 요청 취소). owner면 승계, 없으면 보관. */
export default defineApiHandler(async (event) => leaveSpace(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
