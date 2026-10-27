import { listModerators } from '../../../../../../../modules/community/official'

/** GET /api/v1/operator/community/spaces/:id/moderators — 공식 페이지 모더레이터. */
export default defineApiHandler(async (event) => listModerators(requireDb(), requireActor(event), getRouterParam(event, 'id')))
