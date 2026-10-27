import { getMyFollows } from '../../../../modules/social/follows'

/** GET /api/v1/personas/:id/follows — 내 페르소나의 팔로워·팔로잉·받은 요청·보낸 요청(S-04, 본인만). 남의 것·없는 id 404. */
export default defineApiHandler((event) => getMyFollows(requireDb(), requireActor(event), getRouterParam(event, 'id')))
