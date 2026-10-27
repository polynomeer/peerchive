import { declineApplication } from '../../../../../../../modules/community/recruitments'

/**
 * POST /api/v1/community/recruitments/:id/applications/:appId/decline — 모집자만. 사유를 받지 않습니다(본문 무시).
 * 지원자에게 "모집이 마감되었거나 선정되지 않았습니다" 알림. 200, 403, 404, 409 recruitment_not_open·not_pending.
 */
export default defineApiHandler(async (event) =>
  declineApplication(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'appId')),
)
