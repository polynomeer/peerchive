import { createPublicPublicationHandler } from '../../../../../modules/publication/public-http'

/**
 * GET /api/v1/public/publications/:slug — 익명 공개 조회(로그인 불필요, 쿠키를 읽거나 쓰지 않음).
 * 게시 중인 지금 release의 저장된 스냅샷 + 공개 버전·게시일. 철회·대체·엠바고·준비 중·없음은 모두 404.
 * Cache-Control no-store, X-Robots-Tag noindex(기본), 운영 스위치가 켜지면 503 public_reads_disabled(ADR 0012).
 */
export default createPublicPublicationHandler({ getDb: requireDb })
