import { createSimilarStuckHandler } from '../../../../../../../modules/course-hub/public-http'

/**
 * GET /api/v1/public/publications/:slug/stuck/:itemKey/similar?limit= — 비슷한 공개 막힘(E-05, ADR 0055). 로그인 불필요·쿠키 없음·늘 noindex.
 * 임베딩 공급자가 없거나 카드가 지금 보이지 않으면 404, IP마다 분당 60회(429), 운영 스위치 503.
 */
export default createSimilarStuckHandler({ getDb: requireDb, clientKey: requestIp })
