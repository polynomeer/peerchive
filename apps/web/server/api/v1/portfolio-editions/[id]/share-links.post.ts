import { createShareLink } from '../../../../modules/portfolio/share-links'

/**
 * POST /api/v1/portfolio-editions/:id/share-links {label?, expiresInDays?(1~90, 기본 30)} — 로그인, 내 지금 판만(E-07, ADR 0051).
 * 201 + 링크와 원문 토큰(이 응답에서만). 404(내 판 아님), 409 edition_superseded·limit_reached, 422, 429.
 */
export default defineApiHandler(async (event) => {
  const link = await createShareLink(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return link
})
