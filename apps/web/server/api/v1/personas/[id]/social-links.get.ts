import { listMySocialLinks } from '../../../../modules/social/social-links'

/**
 * GET /api/v1/personas/:id/social-links — 내 페르소나의 소셜 링크·한도·링크한 페이지에 넣을 프로필 주소(S-06, 본인만). 남의 것·없는 id 404.
 */
export default defineApiHandler((event) => listMySocialLinks(requireDb(), requireActor(event), getRouterParam(event, 'id'), primarySiteOrigin()))
