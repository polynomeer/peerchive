import { getLog } from '../../../../modules/logs/logs'

/** GET /api/v1/logs/:id — 현재 revision과 막힘↔해결 연결. 읽을 수 없으면 404. */
export default defineApiHandler((event) => getLog(requireDb(), requireActor(event), getRouterParam(event, 'id')))
