/**
 * 과목 허브·검색 공개 HTTP handler (T-13, ADR 0012·0013). 공개 사례와 같은 공통 handler(`createPublicJsonHandler`)를 써서
 * no-store·nosniff·no-referrer·noindex(기본)·운영 스위치(503)·404 정규화를 똑같이 적용합니다. 쿠키를 읽거나 쓰지 않습니다.
 */
import { getQuery, getRouterParam, type EventHandler } from 'h3'
import { createPublicJsonHandler, type PublicHandlerDeps } from '../publication/public-http'
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
