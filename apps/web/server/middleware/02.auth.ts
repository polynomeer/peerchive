import { validateSessionToken } from '../modules/identity/sessions'
import { isPublicApiPath } from '../modules/publication/public-http'

/**
 * API 요청의 세션 쿠키를 검증해 event.context.auth를 채웁니다.
 * 무효 쿠키는 지우고, sliding 연장이 일어나면 쿠키 만료도 갱신합니다.
 * 공개 조회(/api/v1/public/**)는 건너뜁니다: 로그인 여부와 무관한 같은 응답이고, 쿠키를 지우거나 연장하지 않습니다(ADR 0012).
 */
export default defineEventHandler(async (event) => {
  event.context.auth = null
  if (!event.path.startsWith('/api/') || isPublicApiPath(event.path)) return
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
