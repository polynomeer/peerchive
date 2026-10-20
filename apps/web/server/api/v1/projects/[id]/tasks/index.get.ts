import { listTasks } from '../../../../../modules/tasks/tasks'

/** GET /api/v1/projects/:id/tasks?status= — 멤버(읽기 전용 포함). 상태(todo → doing → done)·순서대로. */
export default defineApiHandler((event) =>
  listTasks(requireDb(), requireActor(event), getRouterParam(event, 'id'), getQuery(event)),
)
