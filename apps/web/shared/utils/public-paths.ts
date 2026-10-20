/**
 * 공개 경로 판정(T-12, T-13, ADR 0012·0013). 화면(app)과 서버가 같은 규칙을 씁니다.
 * - 공개 페이지(`/p/**` 공개 사례, `/c/**` 과목 허브, `/search` 검색): SSR이 로그인 상태(/api/v1/me, 이메일 포함)를 가져오지 않습니다.
 * - 공개 조회 API(`/api/v1/public/**`)의 읽기(GET/HEAD): 세션 미들웨어가 쿠키를 읽거나 쓰지 않습니다.
 *   같은 접두어의 쓰기(예: 로그인한 사용자의 플랜 포크 `POST /public/publications/:slug/fork`)는 세션을 읽고 CSRF 검사를 받습니다.
 */
export const PUBLIC_API_PREFIX = '/api/v1/public/'

export function isPublicApiPath(path: string): boolean {
  return path.startsWith(PUBLIC_API_PREFIX)
}

/** 쿠키 없이 처리하는 익명 공개 요청: 공개 API 접두어 + 읽기 메서드. */
export function isAnonymousPublicRequest(method: string, path: string): boolean {
  const m = method.toUpperCase()
  return isPublicApiPath(path) && (m === 'GET' || m === 'HEAD')
}

const PUBLIC_PAGE_PREFIXES = ['/p', '/c', '/search'] as const

export function isPublicPagePath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0] ?? path
  return PUBLIC_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
