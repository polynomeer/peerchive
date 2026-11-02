import { getProjectGithub } from '../../../../../modules/github/connect'

/** GET /api/v1/projects/:id/github — 저장소 연결 상태(멤버만, 비멤버·스터디 기록 404). owner에게는 고르기를 기다리는 저장소 목록(E-11). */
export default defineApiHandler((event) => {
  requireGithubContext()
  return getProjectGithub(requireDb(), requireActor(event), getRouterParam(event, 'id'))
})
