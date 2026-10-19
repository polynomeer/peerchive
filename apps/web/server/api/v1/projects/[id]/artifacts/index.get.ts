import { listArtifacts } from '../../../../../modules/artifacts/artifacts'

/** GET /api/v1/projects/:id/artifacts — 멤버(읽기 전용 포함). 산출물과 버전별 검사 상태(최신순). */
export default defineApiHandler((event) => listArtifacts(requireDb(), requireActor(event), getRouterParam(event, 'id')))
