import { retryArtifactScan } from '../../../../../../modules/artifacts/artifacts'

/** POST /api/v1/artifacts/:id/versions/:versionId/rescan — owner/editor. 검사 실패(failed) 버전만 다시 검사 대기로(그 밖에는 409). */
export default defineApiHandler((event) =>
  retryArtifactScan(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'versionId')),
)
