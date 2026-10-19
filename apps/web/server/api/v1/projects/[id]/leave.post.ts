import { leaveProject } from '../../../../modules/projects/members'

/** POST /api/v1/projects/:id/leave — 스스로 나가기. owner는 409(먼저 이전). */
export default defineApiHandler(async (event) => {
  await leaveProject(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
