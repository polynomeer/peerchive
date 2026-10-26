import { getOperatorMetrics } from '../../../modules/ops/metrics'

/** GET /api/v1/operator/metrics?from=&to= — 운영자만(403 operator_only). pilot 지표(5 미만 null, DELIVERY_PLAN §6). */
export default defineApiHandler(async (event) => getOperatorMetrics(requireDb(), requireActor(event), getQuery(event)))
