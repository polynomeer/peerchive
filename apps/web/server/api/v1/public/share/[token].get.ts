import { createSharedPortfolioHandler } from '../../../../modules/portfolio/public-http'

/**
 * GET /api/v1/public/share/:token — 제한 공유 링크로 판 하나의 포트폴리오 보기(로그인 불필요, 쿠키 없음, 늘 noindex·no-referrer·no-store).
 * 없거나 철회·만료·지난 판·숨긴 프로필이면 404, IP마다 분당 60회(429), 운영 스위치 503(E-07, ADR 0051).
 * 공유 페이지 SSR이 같은 프로세스에서 부르는 요청은 바깥 페이지 요청(04.share-page)이 이미 셌으므로 한도를 다시 세지 않습니다.
 */
export default createSharedPortfolioHandler({ getDb: requireDb, clientKey: (event) => (isInProcessRequest(event) ? null : requestIp(event)) })
