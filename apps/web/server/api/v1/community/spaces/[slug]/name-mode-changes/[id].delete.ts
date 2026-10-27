import { cancelNameModeChange } from '../../../../../../modules/community/name-modes'

/** DELETE /api/v1/community/spaces/:slug/name-mode-changes/:id — 예약 취소(방장, 적용 전에만, 멤버 알림). 409 not_scheduled·already_effective. */
export default defineApiHandler((event) =>
  cancelNameModeChange(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id')),
)
