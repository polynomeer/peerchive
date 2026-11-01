import { listRoomEvents } from '../../../../../../modules/community/room-events'

/** GET /api/v1/community/spaces/:slug/events — 동문회·OB 방 일정(A-02). 방 멤버만(404), P2 alumni 플래그가 꺼져 있으면 404. */
export default defineApiHandler(async (event) => listRoomEvents(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
