import { createTask } from '../../../../../modules/tasks/tasks'

/** POST /api/v1/projects/:id/tasks {title, note?, assigneeId?, dueAt?, status?} — owner/editor. 201, 한도 초과는 409 limit_reached. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const task = await createTask(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return task
})
