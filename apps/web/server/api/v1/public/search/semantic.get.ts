import { createSemanticSearchHandler } from '../../../../modules/course-hub/public-http'

/**
 * GET /api/v1/public/search/semantic?q=&course=&limit= — "의미로 찾기": 검색어와 의미가 비슷한 공개 막힘(E-05, ADR 0055).
 * 임베딩 공급자가 없으면 404. 검색어는 공급자로만 보내고 저장·로그하지 않으며 IP마다 분당·전체 시간당 한도(429)가 있습니다. 늘 noindex.
 */
export default createSemanticSearchHandler({ getDb: requireDb, clientKey: requestIp })
