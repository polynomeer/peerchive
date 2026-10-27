import { scheduleNameModeChange } from '../../../../../../modules/community/name-modes'

/**
 * POST /api/v1/community/spaces/:slug/name-mode-changes {toMode} — 이름 표시 방식 변경 예약(사용자 방·스터디 방의 방장만, 7일 뒤 적용, 멤버 알림).
 * 201. 403, 404, 409 name_mode_fixed·space_not_active·change_already_scheduled, 422 toMode.
 */
export default defineApiHandler(async (event) => {
  const result = await scheduleNameModeChange(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
