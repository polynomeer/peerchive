import { unlinkRepository } from '../../../../../modules/github/connect'

/** DELETE /api/v1/projects/:id/github — owner만. 수집 중단·근거 후보 삭제·설치 토큰 폐기. 연결이 없어도 204(E-11). */
export default defineApiHandler(async (event) => {
  const ctx = requireGithubContext()
  await unlinkRepository(requireDb(), requireActor(event), getRouterParam(event, 'id'), ctx)
  setResponseStatus(event, 204)
  return null
})
