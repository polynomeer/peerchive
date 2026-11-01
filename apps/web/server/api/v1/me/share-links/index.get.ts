import { listMyShareLinks } from '../../../../modules/portfolio/share-links'

/** GET /api/v1/me/share-links — 내 제한 공유 링크(최근 순, 상태·열람 횟수만, 토큰 없음). E-07, ADR 0051. */
export default defineApiHandler((event) => listMyShareLinks(requireDb(), requireActor(event)))
