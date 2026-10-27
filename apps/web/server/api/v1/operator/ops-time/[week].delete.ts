import { deleteMyOpsTime } from '../../../../modules/ops/time-log'

/** DELETE /api/v1/operator/ops-time/:week — 운영자만(403 operator_only). 내 그 주 기록 삭제(204, 없으면 404). */
export default defineApiHandler(async (event) => {
  await deleteMyOpsTime(requireDb(), requireActor(event), getRouterParam(event, 'week'))
  setResponseStatus(event, 204)
  return null
})
