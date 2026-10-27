/**
 * 커뮤니티 API(`/api/v1/community/**`, C-02, SYSTEM_DESIGN §8.2, ADR 0019).
 * - 모든 응답(오류 포함)에 `X-Robots-Tag: noindex, nofollow`. robots 헤더는 보조 장치이고 실제 차단은 로그인·권한 검사입니다.
 * - 로그인 세션이 없으면 handler에 닿기 전에 401(커뮤니티 경로에는 비로그인 응답이 없음).
 */
export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/v1/community/') && event.path !== '/api/v1/community') return
  setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
  setResponseHeader(event, 'cache-control', 'no-store')
  if (!event.context.auth) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', data: { code: 'unauthenticated' } })
  }
})
