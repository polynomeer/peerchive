import { getGithubIdentity } from '../../../../../modules/github/connect'

/** GET /api/v1/me/integrations/github — 본인 GitHub 계정 연결 상태 {linked, login, linkedAt}. GitHub App 설정이 없으면 404(E-11). */
export default defineApiHandler((event) => {
  requireGithubContext()
  return getGithubIdentity(requireDb(), requireActor(event))
})
