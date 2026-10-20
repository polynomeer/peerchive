/**
 * 내부 API(`/api/internal/*`) 인증: 봇이 보낸 HMAC-SHA256 서명만 받습니다(ADR 0009).
 *
 * - 세션 쿠키로는 절대 부를 수 없습니다. 이 래퍼는 event.context.auth를 비우고 서명만 봅니다.
 *   그래서 Origin 기반 CSRF 미들웨어(`/api/v1`만 검사)에서 빠져 있어도 안전합니다. 브라우저가 쿠키를 실어 보내도
 *   공유 비밀이 없으면 서명을 만들 수 없습니다.
 * - 서명 검증(시각 차이 5분, 상수 시간 비교)은 @peerchive/bot-protocol, nonce 재사용 검사는 여기서 저장소로 합니다.
 * - 실패 이유는 응답에서 구분하지 않고 401 `invalid_signature`입니다. 비밀이 설정되지 않았으면 503 `internal_api_disabled`.
 * - 본문은 원문(raw) 그대로 서명을 확인한 뒤에만 JSON으로 풉니다.
 */
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  NONCE_TTL_SECONDS,
  resolveInternalSecret,
  verifySignature,
} from '@peerchive/bot-protocol'
import { createError, defineEventHandler, getRequestHeader, readRawBody, setResponseHeader, type H3Event } from 'h3'
import { internalRequestNonces, lt, type DbExecutor } from '@peerchive/db'
import { ServiceError } from '../errors'

/** nonce를 처음 보면 기록하고 true, 이미 본 nonce면 false. */
export interface NonceStore {
  claim(nonce: string, now: Date): Promise<boolean>
}

/** DB nonce 저장소. 받을 때마다 10분 지난 nonce를 지웁니다(서명 창이 5분이라 그 뒤로는 skew로 거부됨). */
export function dbNonceStore(db: DbExecutor): NonceStore {
  return {
    async claim(nonce, now) {
      await db
        .delete(internalRequestNonces)
        .where(lt(internalRequestNonces.receivedAt, new Date(now.getTime() - NONCE_TTL_SECONDS * 1000)))
      const rows = await db
        .insert(internalRequestNonces)
        .values({ nonce, receivedAt: now })
        .onConflictDoNothing()
        .returning({ nonce: internalRequestNonces.nonce })
      return rows.length === 1
    },
  }
}

/** 테스트용 메모리 저장소. */
export function memoryNonceStore(): NonceStore {
  const seen = new Set<string>()
  return {
    async claim(nonce) {
      if (seen.has(nonce)) return false
      seen.add(nonce)
      return true
    },
  }
}

/**
 * 웹 서버의 공유 비밀. 비어 있으면 null(내부 API 꺼짐, production에서도 웹은 뜸).
 * 값이 있는데 약하면 production에서 예외(서버가 시작되지 않음, server/plugins/internal-api.ts).
 */
export function resolveWebInternalSecret(value: string | undefined, options: { production: boolean }): string | null {
  if (!value?.trim()) return null
  return resolveInternalSecret(value, options)
}

export interface InternalHandlerOptions {
  getSecret: () => string | null
  getNonceStore: () => NonceStore
  now?: () => Date
  /** 서비스 오류를 HTTP 오류로 바꾸는 함수(server/utils/http.ts의 toHttpError). */
  mapError?: (error: unknown) => unknown
}

/** 내부 API 본문 상한. 봇 요청은 로그 본문(≤5000자) 수준이라 64KB면 충분합니다. */
export const MAX_INTERNAL_BODY_BYTES = 64 * 1024

const tooLarge = () =>
  createError({ statusCode: 413, statusMessage: 'Payload Too Large', data: { code: 'too_large' } })

const unauthorized = () =>
  createError({ statusCode: 401, statusMessage: 'Unauthorized', data: { code: 'invalid_signature' } })

/** 서명된 POST만 받는 handler를 만듭니다. handler는 검증을 마친 JSON 본문을 받습니다. */
export function createInternalHandler<T>(
  options: InternalHandlerOptions,
  handler: (event: H3Event, body: unknown) => Promise<T>,
) {
  return defineEventHandler(async (event) => {
    setResponseHeader(event, 'cache-control', 'no-store')
    // 세션 쿠키로 채워진 로그인 정보는 쓰지 않습니다(쿠키만으로는 부를 수 없음).
    event.context.auth = null
    const secret = options.getSecret()
    if (!secret) {
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', data: { code: 'internal_api_disabled' } })
    }
    if (event.method !== 'POST') {
      throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed', data: { code: 'method_not_allowed' } })
    }
    const now = options.now?.() ?? new Date()
    // 서명한 경로는 원래 요청 경로입니다(라우터가 접두어를 떼어 낸 event.path가 아니라).
    const path = event.node.req.originalUrl || event.path
    // 서명 확인 전에 읽는 본문이므로 크기를 먼저 제한합니다(인증 없는 큰 요청으로 메모리를 쓰지 않게).
    const declared = Number(getRequestHeader(event, 'content-length') ?? '0')
    if (!Number.isFinite(declared) || declared > MAX_INTERNAL_BODY_BYTES) throw tooLarge()
    const body = (await readRawBody(event, 'utf8')) ?? ''
    if (Buffer.byteLength(body, 'utf8') > MAX_INTERNAL_BODY_BYTES) throw tooLarge()
    const check = verifySignature(
      secret,
      {
        timestamp: getRequestHeader(event, HEADER_TIMESTAMP),
        nonce: getRequestHeader(event, HEADER_NONCE),
        signature: getRequestHeader(event, HEADER_SIGNATURE),
      },
      { method: event.method, path, body },
      now,
    )
    if (!check.ok) {
      console.warn(`[internal-api] rejected request (${check.reason}) ${event.method} ${path.split('?')[0]}`)
      throw unauthorized()
    }
    if (!(await options.getNonceStore().claim(check.nonce, now))) {
      console.warn(`[internal-api] rejected request (replay) ${event.method} ${path.split('?')[0]}`)
      throw unauthorized()
    }
    let parsed: unknown
    try {
      parsed = body ? JSON.parse(body) : {}
    } catch {
      throw createError({ statusCode: 422, statusMessage: 'Unprocessable Entity', data: { code: 'invalid_json' } })
    }
    try {
      return await handler(event, parsed)
    } catch (error) {
      if (error instanceof ServiceError && options.mapError) throw options.mapError(error)
      throw error
    }
  })
}
