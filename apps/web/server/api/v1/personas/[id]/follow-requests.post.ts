import { resolvePendingRequests } from '../../../../modules/social/follows'

/**
 * POST /api/v1/personas/:id/follow-requests {action: approve_all | reject_all} — 받은 대기 요청을 한꺼번에 처리(S-04, 본인만).
 * 비공개 → 공개 전환은 대기 요청을 자동 승인하지 않으므로, 화면이 묻고 고른 쪽만 이 API로 보냅니다("그대로 두기"는 부르지 않음).
 */
export default defineApiHandler(async (event) =>
  resolvePendingRequests(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
