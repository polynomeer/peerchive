import { handleSetup } from '../../../modules/github/connect'
import { githubRedirectError } from '../../../modules/github/redirects'

/**
 * GET /api/v1/github/setup — GitHub App의 Setup URL(설치 뒤 GitHub가 보내는 곳, ?installation_id&setup_action&state).
 * state(사용자·과제에 묶임)를 확인하고 installation id를 사용자 인증(OAuth)으로 확인하러 보냅니다. 화면 이동(302)만 하고 JSON을 돌려주지 않습니다.
 * 로그인하지 않았으면 로그인 화면으로. 꺼져 있으면 404(E-11, ADR 0056).
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'referrer-policy', 'no-referrer')
  const ctx = requireGithubContext()
  const auth = event.context.auth
  if (!auth) return sendRedirect(event, '/login', 302)
  try {
    const { redirect } = await handleSetup(requireDb(), { userId: auth.user.id }, getQuery(event), ctx)
    return sendRedirect(event, redirect, 302)
  } catch (error) {
    return sendRedirect(event, githubRedirectError(error), 302)
  }
})
