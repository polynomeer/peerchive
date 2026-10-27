import { saveMyOpsTime } from '../../../../modules/ops/time-log'

/** PUT /api/v1/operator/ops-time/:week {minutes, note?} — 운영자만(403 operator_only). 내 그 주 기록 저장(멱등, 200). 422 week·minutes·note. */
export default defineApiHandler(async (event) => saveMyOpsTime(requireDb(), requireActor(event), getRouterParam(event, 'week'), await readJsonBody(event)))
