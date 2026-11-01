import { putMyRoomProfile } from '../../../../../modules/community/room-profiles'

/** PUT /api/v1/community/spaces/:slug/room-profile {displayName?, badges?, cohortLabel?, bio?} — 내 방별 프로필(A-01). real 방은 이름 422 name_fixed. */
export default defineApiHandler(async (event) => putMyRoomProfile(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event)))
