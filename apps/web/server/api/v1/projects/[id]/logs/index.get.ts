import { listLogs } from '../../../../../modules/logs/logs'

/** GET /api/v1/projects/:id/logs?tag=&author=&cursor=&limit= — 멤버(읽기 전용 포함). 최신순 cursor 페이지. */
export default defineApiHandler((event) =>
  listLogs(requireDb(), requireActor(event), getRouterParam(event, 'id'), getQuery(event)),
)
