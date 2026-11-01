import { updateTask } from '../../../../modules/tasks/tasks'

/** PATCH /api/v1/tasks/:id {expectedVersion, title?, note?, assigneeId?, dueAt?, status?, position?} — owner/editor. 낡은 version은 409. position(E-09)은 상태를 바꿀 때만. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return updateTask(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
