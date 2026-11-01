/**
 * 공개 프로필·README 카드 HTTP handler (T-14, ADR 0012·0014). 공개 사례와 같은 공통 handler를 써서 no-store·nosniff·no-referrer·
 * noindex(기본)·운영 스위치(503)·404 정규화를 똑같이 적용합니다. 세션 미들웨어가 공개 GET을 건너뛰므로 쿠키를 읽거나 쓰지 않습니다.
 */
import { createError, getRouterParam, setResponseHeader, setResponseHeaders, type EventHandler, type H3Event } from 'h3'
import { contentDisposition } from '@peerchive/files'
import { createPublicJsonHandler, createPublicTextHandler, type PublicHandlerDeps } from '../publication/public-http'
import { hitRateLimit, type RateLimitRule } from '../security/rate-limit'
import { PORTFOLIO_PDF_MEDIA_TYPE, portfolioPdfFileName, renderPortfolioPdf } from './pdf'
import { formatReadmeCard, getPublicPortfolioProfile } from './public-profile'
import { SHARE_LINK_VIEW_RATE_LIMIT, getSharedPortfolio } from './share-links'

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

export interface SharedPortfolioHandlerDeps extends PublicHandlerDeps {
  /**
   * 열람 한도 키(요청 IP). null이면 한도를 세지 않습니다 — 공유 페이지 SSR이 같은 프로세스 안에서 부르는 요청으로, 바깥 페이지 요청이
   * 이미 IP마다 셌습니다(server/middleware/04.share-page.ts).
   */
  clientKey: (event: H3Event) => string | null
}

/**
 * GET /api/v1/public/share/:token — 제한 공유 링크(E-07, ADR 0051). 공개 조회 공통 handler(no-store·nosniff·no-referrer·운영 스위치·404 정규화)
 * 위에 **설정과 무관하게 늘 noindex**, IP마다 열람 한도(429)를 더합니다. 세션을 읽지 않습니다(공개 GET).
 */
export function createSharedPortfolioHandler(deps: SharedPortfolioHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, async (db, event, now) => {
    setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
    const key = deps.clientKey(event)
    if (key !== null && !(await hitRateLimit(db, 'share_link_view', key, SHARE_LINK_VIEW_RATE_LIMIT, now))) {
      throw createError({ statusCode: 429, statusMessage: 'Too Many Requests', data: { code: 'rate_limited' } })
    }
    return getSharedPortfolio(db, getRouterParam(event, 'token'), now)
  })
}

/** 지원용 PDF 생성 한도(E-08, ADR 0052): IP마다 분당 10회, 프로필(handle)마다 분당 30회. */
export const PORTFOLIO_PDF_IP_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60 * 1000 }
export const PORTFOLIO_PDF_HANDLE_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 1000 }

export interface PortfolioPdfHandlerDeps extends PublicHandlerDeps {
  /** PDF 안 절대 주소의 사이트 origin(NUXT_SITE_ORIGIN 첫 항목). */
  getOrigin: () => string
  /** 요청 IP(생성 한도 키). */
  clientKey: (event: H3Event) => string
  /** 한글 글꼴(TTF) 바이트. */
  loadFont: () => Promise<Uint8Array>
}

const rateLimited = () => createError({ statusCode: 429, statusMessage: 'Too Many Requests', data: { code: 'rate_limited' } })

/**
 * GET /api/v1/public/profiles/:handle/portfolio.pdf — 지원용 PDF(E-08, ADR 0052). 공개 조회 공통 handler(no-store·nosniff·no-referrer·
 * 운영 스위치 503·404 정규화) 위에 **늘 noindex**, 첨부 파일 응답, IP마다·프로필마다 생성 한도(429)를 더합니다. 세션을 읽지 않습니다.
 * 내용은 공개 프로필 DTO(`getPublicPortfolioProfile`)만으로 만듭니다 — 숨긴·없는 프로필은 404이고 PDF를 만들지 않습니다.
 */
export function createPortfolioPdfHandler(deps: PortfolioPdfHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, async (db, event, now) => {
    setResponseHeaders(event, {
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': "sandbox; default-src 'none'",
      'cross-origin-resource-policy': 'same-origin',
    })
    // IP 한도는 프로필을 읽기 전에 셉니다(없는 handle 요청도 셈).
    if (!(await hitRateLimit(db, 'portfolio_pdf_ip', deps.clientKey(event), PORTFOLIO_PDF_IP_RATE_LIMIT, now))) throw rateLimited()
    const profile = await getPublicPortfolioProfile(db, getRouterParam(event, 'handle'), now)
    // 프로필 한도는 있는 프로필만(없는 handle로 버킷을 늘리지 않게).
    if (!(await hitRateLimit(db, 'portfolio_pdf_handle', profile.handle, PORTFOLIO_PDF_HANDLE_RATE_LIMIT, now))) throw rateLimited()
    const bytes = await renderPortfolioPdf(profile, { font: await deps.loadFont(), origin: deps.getOrigin(), now })
    setResponseHeaders(event, {
      'content-type': PORTFOLIO_PDF_MEDIA_TYPE,
      'content-length': bytes.byteLength,
      'content-disposition': contentDisposition(portfolioPdfFileName(profile.handle), false),
    })
    return bytes
  })
}
