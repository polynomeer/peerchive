import { updateTask } from '../../../../modules/tasks/tasks'

/** PATCH /api/v1/tasks/:id {expectedVersion, title?, note?, assigneeId?, dueAt?, status?} — owner/editor. 낡은 version은 409. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return updateTask(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
