import { getArtifact } from '../../../../modules/artifacts/artifacts'

/** GET /api/v1/artifacts/:id — 멤버. 산출물과 모든 버전(검사 상태 포함). */
export default defineApiHandler((event) => getArtifact(requireDb(), requireActor(event), getRouterParam(event, 'id')))
