import { listMyOpsTime } from '../../../../modules/ops/time-log'

/** GET /api/v1/operator/ops-time — 운영자만(403 operator_only). 내 주간 운영 시간(이번 주 + 최근 12주, 본인 것만). */
export default defineApiHandler(async (event) => listMyOpsTime(requireDb(), requireActor(event)))
