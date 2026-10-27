import { listMetricsSpaces } from '../../../../../modules/community/ops-metrics'

/** GET /api/v1/operator/metrics/community/spaces — 운영자만(403 operator_only). 공간별 보기를 고를 수 있는 공간(active 멤버 기준 이상). */
export default defineApiHandler(async (event) => listMetricsSpaces(requireDb(), requireActor(event)))
