import { listRoomPolls } from '../../../../../../modules/community/room-polls'

/** GET /api/v1/community/spaces/:slug/polls — 동문회·OB 방 투표(A-02). 결과는 선택지별 개수만. 방 멤버만(404). */
export default defineApiHandler(async (event) => listRoomPolls(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
