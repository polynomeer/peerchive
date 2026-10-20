import { listCheckins } from '../../../../../modules/checkins/checkins'

/** GET /api/v1/projects/:id/checkins?week=YYYY-Www — 멤버. 팀 체크인 현황(기본 이번 주). */
export default defineApiHandler((event) =>
  listCheckins(requireDb(), requireActor(event), getRouterParam(event, 'id'), getQuery(event)),
)
