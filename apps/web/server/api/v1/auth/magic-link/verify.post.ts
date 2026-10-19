import { verifyMagicLink } from '../../../../modules/identity/magic-link'

/**
 * POST /api/v1/auth/magic-link/verify {token}
 * "로그인 확인" 페이지(/auth/verify)에서 사용자가 버튼을 눌렀을 때만 토큰을 소비합니다.
 * GET으로 소비하지 않으므로 메일 보안 스캐너가 링크를 미리 열어도 토큰이 사라지지 않습니다.
 * 실패(만료·사용됨·없음·계정 정지)는 이유를 밝히지 않고 410으로 돌려줍니다.
 */
export default defineApiHandler(async (event) => {
  const body = (await readJsonBody(event)) as { token?: unknown }
  const result = await verifyMagicLink(requireDb(), { token: body.token })
  if (!result.ok) throw createError({ statusCode: 410, statusMessage: 'Gone', data: { code: 'link_invalid' } })
  setSessionCookie(event, result.session.token, result.session.expiresAt)
  return { next: result.needsOnboarding ? ('/onboarding' as const) : ('/projects' as const) }
})
