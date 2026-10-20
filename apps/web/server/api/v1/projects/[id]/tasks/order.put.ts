import { reorderTasks } from '../../../../../modules/tasks/tasks'

/** PUT /api/v1/projects/:id/tasks/order {status, taskIds[]} — owner/editor. 그 상태의 전체 순열이 아니면 422. 전체 목록을 돌려줍니다. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return reorderTasks(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
