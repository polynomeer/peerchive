import { createRobotsHandler } from '../modules/security/robots'

/** GET /robots.txt — 공개 색인 설정에 따라 전부 막거나 공개 페이지만 엽니다. 커뮤니티는 항상 막습니다(C-05, ADR 0021). */
export default createRobotsHandler()
