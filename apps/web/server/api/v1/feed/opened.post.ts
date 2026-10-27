import { recordFeedItemOpened } from '../../../modules/social/feed'

/**
 * POST /api/v1/feed/opened {activityId} — 피드 항목 열기 분석 이벤트(S-07, DELIVERY_PLAN §6.2 `feed_item_opened`, 로그인 필요 401). 204.
 * 원천 종류만 사용자 키로 기록합니다(페르소나·원천 id 없음). 없는·거둔 활동은 조용히 넘깁니다. 잘못된 id 422, 한도 429.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  await recordFeedItemOpened(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, 204)
  return null
})
