import { getProfileSocial } from '../../../../modules/social/follows'

/**
 * GET /api/v1/profiles/:handle/social — 세션을 읽는 관계 정보(S-04): 계정 공개 여부, 팔로워 수(`show_follower_count`를 끄면 키 없음, 본인은 늘),
 * 팔로우 목록을 볼 수 있는지, 로그인한 다른 사람이면 내 페르소나별 팔로우·차단 상태와 뮤트. 차단당한 사용자·없는 handle 404.
 */
export default defineApiHandler(async (event) => {
  const auth = event.context.auth
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return getProfileSocial(requireDb(), auth ? { userId: auth.user.id } : null, getRouterParam(event, 'handle'))
})
