import { revokeShareLink } from '../../../../../modules/portfolio/share-links'

/** POST /api/v1/me/share-links/:id/revoke — 철회(다음 요청부터 공유 페이지 404). 이미 철회했으면 그대로 200, 남의 링크 404. E-07, ADR 0051. */
export default defineApiHandler((event) => revokeShareLink(requireDb(), requireActor(event), getRouterParam(event, 'id')))
