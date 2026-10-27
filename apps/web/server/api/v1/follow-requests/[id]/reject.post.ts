import { rejectFollowRequest } from '../../../../modules/social/follows'

/** POST /api/v1/follow-requests/:id/reject — 받은 팔로우 요청 거절(S-04, 행 삭제, 상대에게 알리지 않음). 남의 것·없는 id 404. */
export default defineApiHandler((event) => rejectFollowRequest(requireDb(), requireActor(event), getRouterParam(event, 'id')))
