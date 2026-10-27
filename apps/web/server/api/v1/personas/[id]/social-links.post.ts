import { addSocialLink } from '../../../../modules/social/social-links'

/**
 * POST /api/v1/personas/:id/social-links {provider, url} — 소셜 링크 추가(S-06, 201, 확인 전). 웹은 이 주소에 접속하지 않습니다.
 * 422 `url: invalid | too_long | scheme | credentials | port | ip_literal | host | provider_mismatch`, 409 `limit_reached`·`duplicate`·
 * `used_by_other_persona`·`profile_required`, 남의 페르소나 404.
 */
export default defineApiHandler(async (event) => {
  const link = await addSocialLink(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return link
})
