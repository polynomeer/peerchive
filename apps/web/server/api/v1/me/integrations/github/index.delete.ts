import { unlinkGithubIdentity } from '../../../../../modules/github/connect'

/** DELETE /api/v1/me/integrations/github — 204. 연결 행을 지웁니다(없어도 204). GitHub 쪽 앱 권한 철회는 GitHub 설정에서(E-11). */
export default defineApiHandler(async (event) => {
  requireGithubContext()
  await unlinkGithubIdentity(requireDb(), requireActor(event))
  setResponseStatus(event, 204)
  return null
})
