import { completeOAuth } from '../../../../modules/github/connect'
import { githubRedirectError } from '../../../../modules/github/redirects'

/**
 * GET /api/v1/github/oauth/callback — GitHub App 사용자 인증(user-to-server OAuth)의 Callback URL(?code&state).
 * 회원 계정 연결 또는 설치 확인을 마치고 화면으로 이동(302)합니다. 사용자 토큰은 이 요청 안에서만 쓰고 폐기합니다(E-11, ADR 0056).
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'referrer-policy', 'no-referrer')
  const ctx = requireGithubContext()
  const auth = event.context.auth
  if (!auth) return sendRedirect(event, '/login', 302)
  try {
    const { redirect } = await completeOAuth(requireDb(), { userId: auth.user.id }, getQuery(event), ctx)
    return sendRedirect(event, redirect, 302)
  } catch (error) {
    return sendRedirect(event, githubRedirectError(error), 302)
  }
})
