import { unfollowProfile } from '../../../../modules/social/follows'

/** DELETE /api/v1/profiles/:handle/follow?as=<내 페르소나 id> — 언팔로우·보낸 요청 취소(S-04, 행 삭제, 알림 없음). */
export default defineApiHandler(async (event) =>
  unfollowProfile(requireDb(), requireActor(event), getRouterParam(event, 'handle'), getQuery(event).as),
)
