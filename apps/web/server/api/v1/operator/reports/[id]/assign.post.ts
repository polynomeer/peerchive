import { assignReport } from '../../../../../modules/moderation/operator'

/** POST /api/v1/operator/reports/:id/assign — 운영자만. 나에게 배정(같은 대상의 처리 전 신고를 검토 중으로). 닫힌 신고 409 already_closed. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return assignReport(requireDb(), actor, getRouterParam(event, 'id'))
})
