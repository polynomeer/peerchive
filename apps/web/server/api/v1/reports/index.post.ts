import { createReport } from '../../../modules/moderation/reports'

/**
 * POST /api/v1/reports {targetType, targetRef, reason, details?} — 로그인 필요(401). 지금 공개인 대상만(아니면 404).
 * 새 신고 201, 같은 대상의 처리 전 신고가 이미 있으면 200(created: false). 422, 429(시간당 10회·하루 30회). 개인정보·저작권은 보류를 겁니다(ADR 0015).
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await createReport(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, result.created ? 201 : 200)
  return result
})
