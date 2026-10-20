import { listMyReports } from '../../../modules/moderation/reports'

/** GET /api/v1/me/reports — 내 신고의 상태만(접수·검토 중·처리됨·기각). 조치 내용은 싣지 않습니다. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return listMyReports(requireDb(), actor)
})
