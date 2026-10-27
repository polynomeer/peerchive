import { restrictSpace } from '../../../../../../modules/community/official'

/** POST /api/v1/operator/community/spaces/:id/restrict {note} — 공간 제한(읽기만·목록·가입·쓰기 중지). 409 target_not_public. */
export default defineApiHandler(async (event) => restrictSpace(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
