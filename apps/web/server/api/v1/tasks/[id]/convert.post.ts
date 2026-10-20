import { convertTask } from '../../../../modules/tasks/tasks'

/**
 * POST /api/v1/tasks/:id/convert {tag: stuck|decision|progress, body?, payload, ...} — owner/editor.
 * 빌드 로그(source task)를 만들고 할 일과 연결합니다. 201 {task, log}. 완료 전 409 not_done, 두 번째는 409 already_converted.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await convertTask(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
