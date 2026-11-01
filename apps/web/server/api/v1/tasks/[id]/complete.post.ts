import { completeTask } from '../../../../modules/tasks/tasks'

/**
 * POST /api/v1/tasks/:id/complete {expectedVersion, position?} — owner/editor. 200 {task, prompt}. position(E-09 보드)은 완료 목록의 자리.
 * prompt가 있으면 화면이 "막힌 적 있었나요? 결정할 게 있었나요?"를 묻습니다. 이미 완료했으면 그대로 200.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return completeTask(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
