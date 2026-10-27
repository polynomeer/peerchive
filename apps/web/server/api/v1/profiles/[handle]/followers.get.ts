import { getFollowList } from '../../../../modules/social/follows'

/**
 * GET /api/v1/profiles/:handle/followers — 팔로워 목록(S-04). 세션을 읽어 `follow_lists` 공개 범위를 보는 사람 기준으로 판정합니다(볼 수 없으면
 * `entries: null`). 페르소나의 handle·이름·종류만, 보는 사람에게 차단으로 숨겨진 페르소나는 빠짐. 차단당한 사용자·없는 handle 404.
 */
export default defineApiHandler(async (event) => {
  const auth = event.context.auth
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return getFollowList(requireDb(), auth ? { userId: auth.user.id } : null, getRouterParam(event, 'handle'), 'followers')
})
