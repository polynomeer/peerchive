import { requestSocialLinkVerification } from '../../../../modules/social/social-links'

/**
 * POST /api/v1/social-links/:id/verify — 되돌림 링크 확인 요청(S-06, 202). 웹은 접속하지 않고 worker의 링크 수집기가 가져옵니다(SSRF 방어).
 * 남의 것·없는 id 404, 사용자당·링크당 한도 429.
 */
export default defineApiHandler(async (event) => {
  const link = await requestSocialLinkVerification(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 202)
  return link
})
