import { getCommunityMetrics } from '../../../../../modules/community/ops-metrics'

/**
 * GET /api/v1/operator/metrics/community?from=&to=&space= — 운영자만(403 operator_only). 커뮤니티 지표(C-10, 모든 칸 5 미만 null).
 * space: 운영자가 고른 공간 하나(active 멤버 기준 미만 409 space_too_small, 없으면 404). 422 기간 오류.
 */
export default defineApiHandler(async (event) => getCommunityMetrics(requireDb(), requireActor(event), getQuery(event)))
