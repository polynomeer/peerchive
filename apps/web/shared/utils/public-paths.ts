/**
 * 공개 경로 판정(T-12, ADR 0012). 화면(app)과 서버가 같은 규칙을 씁니다.
 * - 공개 페이지(`/p/**`): SSR이 로그인 상태(/api/v1/me, 이메일 포함)를 가져오지 않습니다.
 * - 공개 조회 API(`/api/v1/public/**`): 세션 미들웨어가 쿠키를 읽거나 쓰지 않습니다.
 */
export const PUBLIC_API_PREFIX = '/api/v1/public/'

export function isPublicApiPath(path: string): boolean {
  return path.startsWith(PUBLIC_API_PREFIX)
}

export function isPublicPagePath(path: string): boolean {
  return path === '/p' || path.startsWith('/p/')
}
