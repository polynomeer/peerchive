import { createCsrfMiddleware } from '../modules/security/csrf'

/** 상태를 바꾸는 /api/v1 요청의 Origin/Referer 검사(403). */
export default createCsrfMiddleware(() => siteOrigins())
