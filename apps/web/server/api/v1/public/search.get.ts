import { createPublicSearchHandler } from '../../../modules/course-hub/public-http'

/**
 * GET /api/v1/public/search?q=&type=case|stuck|note&course= — 익명 공개 검색(쿠키 없음, noindex).
 * 검색 문서는 파생 데이터이며 결과는 항상 지금 공개 상태와 조인해 확인합니다. 형식 오류 422, 운영 스위치 503(ADR 0013).
 */
export default createPublicSearchHandler({ getDb: requireDb })
