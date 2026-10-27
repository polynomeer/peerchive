/**
 * 커뮤니티 열람 범위·검색엔진 비노출 상수(C-05, SYSTEM_DESIGN §8.2, ADR 0021). 화면(app)과 서버가 같은 값을 씁니다.
 * - 커뮤니티 화면·API 응답은 공개 색인 설정과 무관하게 항상 `noindex, nofollow, noarchive`입니다.
 * - 커뮤니티 화면의 문서 제목은 고정 문구이고, 공간 이름·소개·글에서 og:title·og:description·og:image·description을 만들지 않습니다.
 */
export const COMMUNITY_ROBOTS = 'noindex, nofollow, noarchive'

export const COMMUNITY_PAGE_TITLE = 'Peerchive 커뮤니티'

const pathnameOf = (path: string) => path.split(/[?#]/, 1)[0] ?? path

export function isCommunityApiPath(path: string): boolean {
  const p = pathnameOf(path)
  return p === '/api/v1/community' || p.startsWith('/api/v1/community/')
}

export function isCommunityPagePath(path: string): boolean {
  const p = pathnameOf(path)
  return p === '/community' || p.startsWith('/community/')
}
