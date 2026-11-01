import { hitRateLimit } from '../modules/security/rate-limit'
import { SHARE_LINK_VIEW_RATE_LIMIT } from '../modules/portfolio/share-links'
import { isSharePagePath } from '../../shared/utils/public-paths'

/**
 * 제한 공유 링크 페이지(`/s/<token>`, E-07, ADR 0051)의 바깥 경계.
 * - 모든 응답(오류 포함)에 `X-Robots-Tag: noindex, nofollow, noarchive`·`no-store`·`Referrer-Policy: no-referrer`(토큰이 Referer로 새지 않게).
 * - IP마다 열람 한도(공개 API와 같은 버킷 `share_link_view`). SSR이 같은 프로세스에서 부르는 공개 API는 여기서 센 것으로 갈음합니다.
 */
export default defineEventHandler(async (event) => {
  if (!isSharePagePath(event.path) || isInProcessRequest(event)) return
  setResponseHeaders(event, { 'x-robots-tag': 'noindex, nofollow, noarchive', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  const db = useDb()
  if (!db) return
  if (!(await hitRateLimit(db, 'share_link_view', requestIp(event), SHARE_LINK_VIEW_RATE_LIMIT, new Date()))) {
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests', data: { code: 'rate_limited' } })
  }
})
