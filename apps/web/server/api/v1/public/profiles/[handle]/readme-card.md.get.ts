import { createReadmeCardHandler } from '../../../../../modules/portfolio/public-http'

/** GET /api/v1/public/profiles/:handle/readme-card.md — GitHub 프로필 README용 마크다운 카드(공개 프로필과 같은 데이터만, ADR 0014). */
export default createReadmeCardHandler({ getDb: requireDb, getOrigin: primarySiteOrigin })
