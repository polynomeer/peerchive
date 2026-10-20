/**
 * 공개 프로필·README 카드 HTTP handler (T-14, ADR 0012·0014). 공개 사례와 같은 공통 handler를 써서 no-store·nosniff·no-referrer·
 * noindex(기본)·운영 스위치(503)·404 정규화를 똑같이 적용합니다. 세션 미들웨어가 공개 GET을 건너뛰므로 쿠키를 읽거나 쓰지 않습니다.
 */
import { getRouterParam, type EventHandler } from 'h3'
import { createPublicJsonHandler, createPublicTextHandler, type PublicHandlerDeps } from '../publication/public-http'
import { formatReadmeCard, getPublicPortfolioProfile } from './public-profile'

/** GET /api/v1/public/profiles/:handle */
export function createPublicProfileHandler(deps: PublicHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, (db, event, now) => getPublicPortfolioProfile(db, getRouterParam(event, 'handle'), now))
}

export interface ReadmeCardHandlerDeps extends PublicHandlerDeps {
  /** 카드 링크의 사이트 주소(NUXT_SITE_ORIGIN 첫 항목). */
  getOrigin: () => string
}

/** GET /api/v1/public/profiles/:handle/readme-card.md — GitHub 프로필 README용 마크다운(text/markdown). */
export function createReadmeCardHandler(deps: ReadmeCardHandlerDeps): EventHandler {
  return createPublicTextHandler(deps, 'text/markdown; charset=utf-8', async (db, event, now) =>
    formatReadmeCard(await getPublicPortfolioProfile(db, getRouterParam(event, 'handle'), now), deps.getOrigin()),
  )
}
