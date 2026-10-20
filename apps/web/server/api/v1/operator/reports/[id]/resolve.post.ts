import { resolveReport } from '../../../../../modules/moderation/operator'

/**
 * POST /api/v1/operator/reports/:id/resolve {action: none|restrict|hide_item|hide_note|hide_case_study|hide_profile, note, publicReason?, notifyOwner}
 * — 운영자만. 조치·신고 닫기·보류 해제·감사·outbox를 한 트랜잭션에. 409 already_closed·target_not_public, 422 action: not_applicable 등.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return resolveReport(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
