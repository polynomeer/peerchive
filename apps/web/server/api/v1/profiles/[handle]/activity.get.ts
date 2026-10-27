import { getProfileActivity } from '../../../../modules/social/feed'

/**
 * GET /api/v1/profiles/:handle/activity?kind=&cursor= — 세션을 읽는 활동 목록(S-05). 보는 사람이 볼 수 있는 종류(`kinds`)와 그 활동(최근 순, 20개씩).
 * 공개 화면은 SSR 뒤 브라우저에서만 부릅니다(보는 사람에 따라 달라지는 내용이 SSR HTML에 들어가지 않음). 차단당한 사용자·없는 handle 404, 모르는 kind·cursor 422.
 */
export default defineApiHandler(async (event) => {
  const auth = event.context.auth
  setResponseHeader(event, 'cache-control', 'private, no-store')
  const query = getQuery(event)
  return getProfileActivity(requireDb(), auth ? { userId: auth.user.id } : null, getRouterParam(event, 'handle'), { kind: query.kind, cursor: query.cursor })
})
