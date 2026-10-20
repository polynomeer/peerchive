/**
 * 공개 조회 HTTP 계층 (T-12, SYSTEM_DESIGN §10·§11·§14, ADR 0012). Nuxt 자동 import 없이 h3만 써서 테스트에서 그대로 조립합니다.
 *
 * - 경로: `/api/v1/public/**`. 세션 미들웨어가 이 경로를 건너뛰므로(쿠키를 읽지도, 지우거나 연장하지도 않음) 로그인 여부와
 *   무관하게 같은 응답이고 `Set-Cookie`가 없습니다.
 * - 운영 스위치: `PEERCHIVE_PUBLIC_READS_DISABLED=1`(또는 true/yes/on)이면 모든 공개 조회가 DB를 건드리지 않고 503
 *   `public_reads_disabled`입니다. 요청마다 환경 변수를 읽습니다(권한 누출·파일 공개 오류 때 공개 읽기 전체를 잠시 막는 스위치, §14).
 * - 캐시: JSON·파일 모두 `Cache-Control: no-store`. 철회 뒤에 브라우저·중간 캐시가 이전 응답을 내줄 수 없게 합니다.
 *   파일 ETag에는 access_epoch·공개 버전을 넣습니다(캐시를 켜게 되더라도 철회가 우선하도록).
 * - 색인: 파일럿 동안 기본 `X-Robots-Tag: noindex`. `PEERCHIVE_PUBLIC_INDEXING=1`이면 공개 JSON·페이지에서 뺍니다(파일은 항상 noindex).
 */
import {
  createError,
  defineEventHandler,
  getRouterParam,
  sendStream,
  setResponseHeader,
  setResponseHeaders,
  type EventHandler,
  type H3Event,
} from 'h3'
import { isInlineMediaType } from '@peerchive/domain'
import { contentDisposition, type ObjectStorage } from '@peerchive/files'
import type { DbExecutor } from '@peerchive/db'
import { ServiceError } from '../errors'
import { isPublicApiPath } from '../../../shared/utils/public-paths'
import { getPublicPublication, openPublicArtifact } from './public-read'

export { PUBLIC_API_PREFIX, isAnonymousPublicRequest, isPublicApiPath, isPublicPagePath } from '../../../shared/utils/public-paths'

type Env = Readonly<Record<string, string | undefined>>
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const flag = (value: string | undefined) => TRUTHY.has((value ?? '').trim().toLowerCase())

/** 운영 스위치: 공개 읽기 전체 차단. */
export function publicReadsDisabled(env: Env): boolean {
  return flag(env.PEERCHIVE_PUBLIC_READS_DISABLED)
}

/** 검색엔진 색인 허용(기본 꺼짐, 파일럿은 noindex). */
export function publicIndexingAllowed(env: Env): boolean {
  return flag(env.PEERCHIVE_PUBLIC_INDEXING)
}

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const

function disabledError() {
  return createError({ statusCode: 503, statusMessage: 'Service Unavailable', data: { code: 'public_reads_disabled' } })
}

function notFoundError() {
  return createError({ statusCode: 404, statusMessage: 'Not Found', data: { code: 'not_found' } })
}

function mapError(error: unknown): unknown {
  if (error instanceof ServiceError && error.code === 'NOT_FOUND') return notFoundError()
  // 검색어 형식 오류 등(T-13). 필드별 코드만 싣습니다.
  if (error instanceof ServiceError && error.code === 'VALIDATION') {
    return createError({ statusCode: 422, statusMessage: 'Unprocessable Entity', data: { code: error.reason ?? 'validation_failed', fields: error.fields ?? {} } })
  }
  return error
}

function applyBase(event: H3Event, env: Env, options: { alwaysNoindex?: boolean } = {}) {
  setResponseHeaders(event, BASE_HEADERS)
  if (options.alwaysNoindex || !publicIndexingAllowed(env)) setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
}

/** 서버 미들웨어: 운영 스위치가 켜져 있으면 공개 조회 API를 503으로 막습니다(handler보다 먼저, DB 접근 없음). */
export function createPublicKillSwitch(getEnv: () => Env = () => process.env): EventHandler {
  return defineEventHandler((event) => {
    if (!isPublicApiPath(event.path)) return
    const env = getEnv()
    if (!publicReadsDisabled(env)) return
    applyBase(event, env, { alwaysNoindex: true })
    setResponseHeader(event, 'retry-after', 300)
    throw disabledError()
  })
}

export interface PublicHandlerDeps {
  getDb: () => DbExecutor
  getEnv?: () => Env
  now?: () => Date
}

/**
 * 익명 공개 JSON handler 공통(T-12, T-13): 공개 헤더(no-store·nosniff·no-referrer·noindex 기본) + 운영 스위치 확인 + 404 정규화.
 * `run`은 요청마다 DB를 읽어 지금 공개인 것만 돌려줘야 합니다.
 */
export function createPublicJsonHandler<T>(
  deps: PublicHandlerDeps,
  run: (db: DbExecutor, event: H3Event, now: Date) => Promise<T>,
): EventHandler {
  const getEnv = deps.getEnv ?? (() => process.env)
  return defineEventHandler(async (event) => {
    const env = getEnv()
    applyBase(event, env)
    // 미들웨어가 없어도 막히도록 handler에서도 확인합니다.
    if (publicReadsDisabled(env)) throw disabledError()
    try {
      return await run(deps.getDb(), event, deps.now?.() ?? new Date())
    } catch (error) {
      throw mapError(error)
    }
  })
}

/**
 * 익명 공개 텍스트 handler(T-14 README 카드 등): JSON handler와 같은 공개 헤더·운영 스위치·404 정규화 + 지정한 Content-Type.
 */
export function createPublicTextHandler(
  deps: PublicHandlerDeps,
  contentType: string,
  run: (db: DbExecutor, event: H3Event, now: Date) => Promise<string>,
): EventHandler {
  const getEnv = deps.getEnv ?? (() => process.env)
  return defineEventHandler(async (event) => {
    const env = getEnv()
    applyBase(event, env)
    if (publicReadsDisabled(env)) throw disabledError()
    let body: string
    try {
      body = await run(deps.getDb(), event, deps.now?.() ?? new Date())
    } catch (error) {
      throw mapError(error)
    }
    setResponseHeader(event, 'content-type', contentType)
    return body
  })
}

/** GET /api/v1/public/publications/:slug */
export function createPublicPublicationHandler(deps: PublicHandlerDeps): EventHandler {
  return createPublicJsonHandler(deps, (db, event, now) => getPublicPublication(db, getRouterParam(event, 'slug'), now))
}

export interface PublicArtifactHandlerDeps extends PublicHandlerDeps {
  getStorage: () => ObjectStorage
}

/**
 * GET /api/v1/public/publications/:slug/artifacts/:versionId — 비공개 열람 경로와 같은 보안 헤더(nosniff, sandbox CSP,
 * Content-Disposition, CORP same-origin) + no-store + access_epoch를 넣은 ETag. 파일 이름은 스냅샷의 공개 표시 이름입니다.
 */
export function createPublicArtifactHandler(deps: PublicArtifactHandlerDeps): EventHandler {
  const getEnv = deps.getEnv ?? (() => process.env)
  return defineEventHandler(async (event) => {
    const env = getEnv()
    applyBase(event, env, { alwaysNoindex: true })
    if (publicReadsDisabled(env)) throw disabledError()
    let content
    try {
      content = await openPublicArtifact(
        deps.getDb(),
        deps.getStorage(),
        getRouterParam(event, 'slug'),
        getRouterParam(event, 'versionId'),
        deps.now?.() ?? new Date(),
      )
    } catch (error) {
      throw mapError(error)
    }
    setResponseHeaders(event, {
      'content-type': content.mediaType,
      'content-length': content.bytes,
      'content-security-policy': "sandbox; default-src 'none'",
      'content-disposition': contentDisposition(content.fileName, isInlineMediaType(content.mediaType)),
      'cross-origin-resource-policy': 'same-origin',
      etag: content.etag,
    })
    return sendStream(event, content.stream)
  })
}
