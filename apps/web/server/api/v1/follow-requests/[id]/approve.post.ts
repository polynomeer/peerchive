import { approveFollowRequest } from '../../../../modules/social/follows'

/** POST /api/v1/follow-requests/:id/approve — 받은 팔로우 요청 승인(S-04, 본인만). 남의 것·없는 id·처리된 요청 404. 알림 없음. */
export default defineApiHandler((event) => approveFollowRequest(requireDb(), requireActor(event), getRouterParam(event, 'id')))
