import { getFollowSuggestions } from '../../../modules/social/feed'

/** GET /api/v1/feed/suggestions — 팔로우 추천(S-05, 로그인 필요 401). 같은 과목·같은 학교·관심 직무 교집합만, 팔로워 수 정렬 없음. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return getFollowSuggestions(requireDb(), actor)
})
