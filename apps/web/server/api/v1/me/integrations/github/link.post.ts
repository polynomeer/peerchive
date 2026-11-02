import { startIdentityLink } from '../../../../../modules/github/connect'

/** POST /api/v1/me/integrations/github/link — 201 {url}: GitHub 사용자 인증 주소(state 10분·한 번만). 화면은 이 주소로 이동합니다(E-11). */
export default defineApiHandler(async (event) => {
  const ctx = requireGithubContext()
  const result = await startIdentityLink(requireDb(), requireActor(event), ctx)
  setResponseStatus(event, 201)
  return result
})
