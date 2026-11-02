import { startInstall } from '../../../../../modules/github/connect'

/** POST /api/v1/projects/:id/github/install — owner만. 201 {url}: 앱 설치 주소(state가 사용자·과제에 묶임, 10분·한 번만). 이미 연결이면 409 already_linked(E-11). */
export default defineApiHandler(async (event) => {
  const ctx = requireGithubContext()
  const result = await startInstall(requireDb(), requireActor(event), getRouterParam(event, 'id'), ctx)
  setResponseStatus(event, 201)
  return result
})
