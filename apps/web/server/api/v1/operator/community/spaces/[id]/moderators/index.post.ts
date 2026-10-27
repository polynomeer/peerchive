import { assignModerator } from '../../../../../../../modules/community/official'

/** POST /api/v1/operator/community/spaces/:id/moderators {userId} — 공식 페이지 모더레이터 지정(그 학교 인증 필요). */
export default defineApiHandler(async (event) => assignModerator(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
