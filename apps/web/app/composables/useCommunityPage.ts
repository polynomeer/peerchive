import { COMMUNITY_PAGE_TITLE, COMMUNITY_ROBOTS } from '~~/shared/utils/community-visibility'

/**
 * 커뮤니티 화면 공통 머리말(C-05, ADR 0021). 모든 `/community/**` 화면이 setup 맨 앞에서 부릅니다.
 * - 제목은 고정 문구(`Peerchive 커뮤니티`)이고 공간 이름·소개·글로 만들지 않습니다.
 * - 사이트 기본 description을 지우고, og:title·og:description·og:image를 만들지 않습니다(링크 미리보기는 일반 카드만).
 * - robots meta `noindex, nofollow, noarchive`, referrer `no-referrer`. 같은 값의 HTTP 헤더는 서버 미들웨어(03.community)가 붙입니다.
 */
export function useCommunityPage(): void {
  useHead({
    title: COMMUNITY_PAGE_TITLE,
    meta: [
      { key: 'description', name: 'description', content: null },
      { key: 'robots', name: 'robots', content: COMMUNITY_ROBOTS },
      { key: 'referrer', name: 'referrer', content: 'no-referrer' },
    ],
  })
}
