import { listRoomProfiles } from '../../../../../../modules/community/room-profiles'

/** GET /api/v1/community/spaces/:slug/room-profiles — 동문회·OB 방의 방별 프로필(A-01). 방 멤버만(404), P2 alumni 플래그가 꺼져 있으면 404, 익명 방 409. */
export default defineApiHandler(async (event) => listRoomProfiles(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
