import { getFollowList } from '../../../../modules/social/follows'

/** GET /api/v1/profiles/:handle/following — 팔로잉 목록(S-04). 규칙은 followers와 같습니다(`follow_lists`, 차단 404, handle·이름·종류만). */
export default defineApiHandler(async (event) => {
  const auth = event.context.auth
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return getFollowList(requireDb(), auth ? { userId: auth.user.id } : null, getRouterParam(event, 'handle'), 'following')
})
