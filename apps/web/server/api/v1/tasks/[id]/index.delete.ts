import { deleteTask } from '../../../../modules/tasks/tasks'

/** DELETE /api/v1/tasks/:id — owner/editor. 빌드 로그로 전환한 할 일은 409 converted. 204. */
export default defineApiHandler(async (event) => {
  await deleteTask(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
