import { getNameModeState } from '../../../../../../modules/community/name-modes'

/** GET /api/v1/community/spaces/:slug/name-mode-changes — 지금 방식·예약·변경 이력(공간을 읽을 수 있는 사람, 아니면 404). */
export default defineApiHandler((event) => getNameModeState(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
