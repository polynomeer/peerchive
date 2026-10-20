import { getMyCheckin } from '../../../../../modules/checkins/checkins'

/** GET /api/v1/projects/:id/checkins/me?week=YYYY-Www — 본인 체크인(없으면 checkin: null). */
export default defineApiHandler((event) =>
  getMyCheckin(requireDb(), requireActor(event), getRouterParam(event, 'id'), getQuery(event)),
)
