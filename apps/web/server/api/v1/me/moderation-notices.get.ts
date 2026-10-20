import { listMyModerationNotices } from '../../../modules/moderation/notices'

/** GET /api/v1/me/moderation-notices — 내가 당사자인 운영 조치 안내(운영자가 알림을 켠 것, 당사자용 사유·이의 상태만). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return listMyModerationNotices(requireDb(), actor)
})
