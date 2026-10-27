import { getSpaceModeration } from '../../../../../modules/community/moderation'

/** GET /api/v1/community/spaces/:slug/moderation — 방 운영진의 공간 운영 화면(C-06). 작성자 정보 없음. 403 moderate_not_allowed, 404. */
export default defineApiHandler(async (event) => getSpaceModeration(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
