/**
 * CSRF 방어: 상태를 바꾸는 /api/v1 요청(POST/PATCH/PUT/DELETE)은 Origin(없으면 Referer)이
 * 허용된 사이트 origin과 정확히 같아야 합니다. 둘 다 없거나 `null`이면 거부합니다.
 * 세션 쿠키 SameSite=Lax와 함께 쓰는 방어층입니다(§14).
 */
import { createError, defineEventHandler, getRequestHeader, type H3Event } from 'h3'

const STATE_CHANGING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export interface CsrfRequest {
  method: string
  path: string
  origin?: string | null
  referer?: string | null
}

/** 설정 문자열(쉼표 구분)을 정규화된 origin 목록으로 바꿉니다. 잘못된 항목은 버립니다. */
export function parseAllowedOrigins(value: string | readonly string[]): string[] {
  const items = typeof value === 'string' ? value.split(',') : value
  const origins: string[] = []
  for (const item of items) {
    const origin = toOrigin(item.trim())
    if (origin) origins.push(origin)
  }
  return origins
}

function toOrigin(value: string): string | null {
  if (!value || value === 'null') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

export function requiresCsrfCheck(method: string, path: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase()) && (path === '/api/v1' || path.startsWith('/api/v1/'))
}

/** true면 통과. 검사 대상이 아닌 요청도 true입니다. */
export function isSameSiteRequest(request: CsrfRequest, allowedOrigins: readonly string[]): boolean {
  if (!requiresCsrfCheck(request.method, request.path)) return true
  if (allowedOrigins.length === 0) return false
  // Origin이 있으면 그것만 봅니다(Referer로 우회하지 않음).
  if (request.origin != null && request.origin !== '') {
    const origin = toOrigin(request.origin)
    return origin !== null && allowedOrigins.includes(origin)
  }
  if (request.referer) {
    const origin = toOrigin(request.referer)
    return origin !== null && allowedOrigins.includes(origin)
  }
  return false
}

/** Nitro 서버 미들웨어. 허용 origin은 요청마다 읽어 설정 변경에 따릅니다. */
export function createCsrfMiddleware(getAllowedOrigins: (event: H3Event) => readonly string[]) {
  return defineEventHandler((event) => {
    const path = event.path.split('?')[0] ?? ''
    const ok = isSameSiteRequest(
      {
        method: event.method,
        path,
        origin: getRequestHeader(event, 'origin'),
        referer: getRequestHeader(event, 'referer'),
      },
      getAllowedOrigins(event),
    )
    if (!ok) {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden', data: { code: 'csrf_origin_mismatch' } })
    }
  })
}
