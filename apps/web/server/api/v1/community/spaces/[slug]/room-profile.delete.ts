import { deleteMyRoomProfile } from '../../../../../modules/community/room-profiles'

/** DELETE /api/v1/community/spaces/:slug/room-profile — 내 방별 프로필과 내 기수 이력 지우기(A-01). */
export default defineApiHandler(async (event) => deleteMyRoomProfile(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
