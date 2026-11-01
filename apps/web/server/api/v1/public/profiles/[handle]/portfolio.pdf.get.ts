import { createPortfolioPdfHandler } from '../../../../../modules/portfolio/public-http'

/**
 * GET /api/v1/public/profiles/:handle/portfolio.pdf — 지원용 PDF(E-08, ADR 0052). 공개 프로필과 같은 DTO만으로 서버에서 만든 A4 PDF(첨부).
 * 로그인 불필요·쿠키 없음·늘 noindex·no-store, 없는·숨긴 프로필 404, IP마다 분당 10회·프로필마다 분당 30회(429), 운영 스위치 503.
 */
export default createPortfolioPdfHandler({ getDb: requireDb, getOrigin: primarySiteOrigin, clientKey: requestIp, loadFont: loadPortfolioPdfFont })
