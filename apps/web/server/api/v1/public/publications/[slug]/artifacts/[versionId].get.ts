import { createPublicArtifactHandler } from '../../../../../../modules/publication/public-http'

/**
 * GET /api/v1/public/publications/:slug/artifacts/:versionId — 지금 release 스냅샷에 들어 있고 지금도 clean인 파일만(그 밖에는 404).
 * nosniff·sandbox CSP·Content-Disposition(공개 표시 이름)·CORP same-origin·no-store·access_epoch ETag(ADR 0012).
 */
export default createPublicArtifactHandler({ getDb: requireDb, getStorage: useObjectStorage })
