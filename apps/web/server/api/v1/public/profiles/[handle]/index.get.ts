import { createPublicProfileHandler } from '../../../../../modules/portfolio/public-http'

/**
 * GET /api/v1/public/profiles/:handle — 익명 공개 프로필(로그인 불필요, 쿠키 없음). 지금 판의 대표 케이스(게시 중 + 원본 release 제공 가능할 때만
 * 글)·역량 × 근거·자기 선언 스킬·후배 기여 개수·타임라인. 이메일·내부 id 없음. 없는 handle 404, 운영 스위치 503(ADR 0014).
 */
export default createPublicProfileHandler({ getDb: requireDb })
