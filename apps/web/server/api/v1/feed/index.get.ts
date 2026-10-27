import { getFeed } from '../../../modules/social/feed'

/**
 * GET /api/v1/feed?cursor= — 내 팔로우 피드(S-05, 로그인 필요 401). 읽을 때마다 공개 범위·차단·뮤트·원본 상태를 다시 확인하고, 하루 단위로 기록
 * (사례·노트·스터디)을 글보다 먼저 보여 줍니다(인기 정렬 없음). 모르는 cursor 422.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return getFeed(requireDb(), actor, { cursor: getQuery(event).cursor })
})
