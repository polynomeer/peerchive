import { validateSessionToken } from '../modules/identity/sessions'
import { isCommunityPagePath } from '../modules/community/http'
import { isAnonymousPublicRequest } from '../modules/publication/public-http'

/**
 * API 요청의 세션 쿠키를 검증해 event.context.auth를 채웁니다.
 * 무효 쿠키는 지우고, sliding 연장이 일어나면 쿠키 만료도 갱신합니다.
 * 공개 조회(/api/v1/public/**의 GET/HEAD)는 건너뜁니다: 로그인 여부와 무관한 같은 응답이고, 쿠키를 지우거나 연장하지 않습니다(ADR 0012).
 * 같은 접두어의 쓰기(플랜 포크 POST, T-13)는 로그인이 필요하므로 세션을 읽습니다(ADR 0013).
 * 커뮤니티 화면(`/community/**`)도 세션을 읽습니다: 03.community가 비로그인 요청을 SSR 전에 404로 끊습니다(C-05, ADR 0021).
 */
export default defineEventHandler(async (event) => {
  event.context.auth = null
  if (!(event.path.startsWith('/api/') || isCommunityPagePath(event.path)) || isAnonymousPublicRequest(event.method, event.path)) return
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
