/**
 * 과목 허브·검색 공개 HTTP handler (T-13, ADR 0012·0013). 공개 사례와 같은 공통 handler(`createPublicJsonHandler`)를 써서
 * no-store·nosniff·no-referrer·noindex(기본)·운영 스위치(503)·404 정규화를 똑같이 적용합니다. 쿠키를 읽거나 쓰지 않습니다.
 */
import { createError, getQuery, getRouterParam, setResponseHeader, type EventHandler, type H3Event } from 'h3'
import { createPublicJsonHandler, type PublicHandlerDeps } from '../publication/public-http'
import { ServiceError } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import { EmbeddingUnavailableError, SIMILAR_STUCK_IP_RATE_LIMIT, semanticStuckSearch, similarToStuckCard } from './similar-stuck'
import { searchPublic } from './search'
import { getCourseHubView } from './staged-opening'

/** GET /api/v1/public/courses/:id — 열린 허브 또는 "준비 중"(E-02 단계적 개방, 플래그가 꺼져 있으면 항상 열린 허브). */
export function createPublicCourseHubHandler(deps: PublicHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, (db, event, now) => getCourseHubView(db, getRouterParam(event, 'id'), now))
}

/** GET /api/v1/public/search?q=&type=&course= */
export function createPublicSearchHandler(deps: PublicHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, (db, event, now) => searchPublic(db, getQuery(event), now))
}

export interface SemanticHandlerDeps extends PublicHandlerDeps {
  /** 요청 한도 키(요청 IP). */
  clientKey: (event: H3Event) => string
}

const tooMany = () => createError({ statusCode: 429, statusMessage: 'Too Many Requests', data: { code: 'rate_limited' } })

/**
 * GET /api/v1/public/publications/:slug/stuck/:itemKey/similar — 비슷한 공개 막힘(E-05, ADR 0055). 공급자가 없으면 404, 늘 noindex,
 * IP마다 분당 60회(429). 공급자를 부르지 않습니다(저장된 벡터만).
 */
export function createSimilarStuckHandler(deps: SemanticHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, async (db, event, now) => {
    setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
    // 꺼져 있거나 카드가 없으면 한도를 세기 전에 404.
    const value = await similarToStuckCard(db, getRouterParam(event, 'slug'), getRouterParam(event, 'itemKey'), getQuery(event), now)
    if (!(await hitRateLimit(db, 'similar_stuck_ip', deps.clientKey(event), SIMILAR_STUCK_IP_RATE_LIMIT, now))) throw tooMany()
    return value
  })
}

/**
 * GET /api/v1/public/search/semantic?q=&course=&limit= — "의미로 찾기"(E-05). 공급자가 없으면 404, 늘 noindex, 검색어 임베딩은 IP마다 분당·전체 시간당 한도(429),
 * 공급자 오류 503 `embedding_unavailable`. 검색어는 저장·로그하지 않습니다.
 */
export function createSemanticSearchHandler(deps: SemanticHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, async (db, event, now) => {
    setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
    try {
      return await semanticStuckSearch(db, getQuery(event), deps.clientKey(event), now)
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'RATE_LIMITED') throw tooMany()
      if (error instanceof EmbeddingUnavailableError) {
        throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', data: { code: 'embedding_unavailable' } })
      }
      throw error
    }
  })
}
