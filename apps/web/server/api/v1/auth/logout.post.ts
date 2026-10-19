import { invalidateSession } from '../../../modules/identity/sessions'

/** POST /api/v1/auth/logout — 현재 세션을 지우고 쿠키를 삭제합니다. 로그인하지 않았어도 204. */
export default defineApiHandler(async (event) => {
  const auth = event.context.auth
  if (auth) await invalidateSession(requireDb(), auth.sessionId)
  clearSessionCookie(event)
  setResponseStatus(event, 204)
  return null
})
