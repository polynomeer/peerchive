import { listMySignals } from '../../../modules/course-hub/signals'

/** GET /api/v1/me/signals — 내가 남긴 신호 중 대상이 지금 공개인 것(눌림 표시용). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return listMySignals(requireDb(), actor)
})
