import { decideCapacity } from '../../../../../../modules/community/official'

/** POST /api/v1/operator/community/spaces/:id/capacity {capacity} — 정원 검토(사용자 방, 2~2000). */
export default defineApiHandler(async (event) => decideCapacity(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
