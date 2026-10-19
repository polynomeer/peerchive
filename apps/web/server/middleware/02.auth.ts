import { validateSessionToken } from '../modules/identity/sessions'

/**
 * API 요청의 세션 쿠키를 검증해 event.context.auth를 채웁니다.
 * 무효 쿠키는 지우고, sliding 연장이 일어나면 쿠키 만료도 갱신합니다.
 */
export default defineEventHandler(async (event) => {
  event.context.auth = null
  if (!event.path.startsWith('/api/')) return
  const token = getSessionToken(event)
  if (!token) return
  const db = useDb()
  if (!db) return

  const session = await validateSessionToken(db, token)
  if (!session) {
    clearSessionCookie(event)
    return
  }
  event.context.auth = { sessionId: session.sessionId, user: session.user }
  if (session.renewed) setSessionCookie(event, token, session.expiresAt)
})
