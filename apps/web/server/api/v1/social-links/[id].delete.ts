import { removeSocialLink } from '../../../modules/social/social-links'

/** DELETE /api/v1/social-links/:id — 내 소셜 링크 삭제(S-06). 남의 것·없는 id 404. */
export default defineApiHandler((event) => removeSocialLink(requireDb(), requireActor(event), getRouterParam(event, 'id')))
