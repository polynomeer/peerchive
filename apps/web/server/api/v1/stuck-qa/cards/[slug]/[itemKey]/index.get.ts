import { getStuckQaCard } from '../../../../../../modules/course-hub/stuck-qa'

/**
 * GET /api/v1/stuck-qa/cards/:slug/:itemKey — 막힘 카드의 질문 허용·스레드 목록(E-04, ADR 0049). 로그인 없이도 봅니다(세션이 있으면 viewer).
 * 카드가 지금 보이지 않거나(철회·제한·엠바고·가림) 플래그가 꺼져 있으면 404. 보는 사람마다 다른 응답이라 저장하지 않습니다.
 */
export default defineApiHandler(async (event) => {
  const auth = event.context.auth
  setResponseHeader(event, 'cache-control', 'private, no-store')
  setResponseHeader(event, 'x-robots-tag', 'noindex')
  return getStuckQaCard(requireDb(), auth ? { userId: auth.user.id } : null, getRouterParam(event, 'slug'), getRouterParam(event, 'itemKey'))
})
