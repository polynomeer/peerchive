import { followProfile } from '../../../../modules/social/follows'

/**
 * POST /api/v1/profiles/:handle/follow {as: 내 페르소나 id} — 팔로우(S-04). 공개 계정은 `{status: 'active'}`, 비공개 계정은 `{status: 'pending'}`.
 * 로그인 필요(401). 없는 handle·차단당함 404, `as` 422, 자기 페르소나 409 `own_persona`, 내가 차단한 페르소나 409 `blocked_by_you`, 한도 429.
 */
export default defineApiHandler(async (event) =>
  followProfile(requireDb(), requireActor(event), getRouterParam(event, 'handle'), await readJsonBody(event)),
)
