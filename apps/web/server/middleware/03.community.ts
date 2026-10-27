import { createCommunityGuard } from '../modules/community/http'

/**
 * 커뮤니티 화면(`/community/**`)·API(`/api/v1/community/**`)의 경계(C-02, C-05, SYSTEM_DESIGN §8.2, ADR 0019·0021).
 * - 모든 응답(오류 포함)에 `X-Robots-Tag: noindex, nofollow, noarchive`·`no-store`·`no-referrer`·`nosniff`.
 * - 로그인 세션이 없으면 handler·SSR 전에 끊습니다: 화면은 404 고정 HTML(payload·방 이름·OG 없음), API는 401 `unauthenticated`.
 */
export default createCommunityGuard()
