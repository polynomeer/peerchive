import type { H3Event } from 'h3'
import { ServiceError, type ServiceErrorCode } from '../modules/errors'

const STATUS: Record<ServiceErrorCode, { statusCode: number; statusMessage: string }> = {
  NOT_FOUND: { statusCode: 404, statusMessage: 'Not Found' },
  FORBIDDEN: { statusCode: 403, statusMessage: 'Forbidden' },
  CONFLICT: { statusCode: 409, statusMessage: 'Conflict' },
  GONE: { statusCode: 410, statusMessage: 'Gone' },
  PAYLOAD_TOO_LARGE: { statusCode: 413, statusMessage: 'Payload Too Large' },
  VALIDATION: { statusCode: 422, statusMessage: 'Unprocessable Entity' },
  RATE_LIMITED: { statusCode: 429, statusMessage: 'Too Many Requests' },
}

/** 서비스 오류를 HTTP 오류로 바꿉니다. 응답 data에는 짧은 코드·필드별 코드·복구용 추가 값만 싣습니다. */
export function toHttpError(error: unknown): unknown {
  if (!(error instanceof ServiceError)) return error
  return createError({
    ...STATUS[error.code],
    data: {
      code: error.reason ?? error.code.toLowerCase(),
      ...error.details,
      ...(error.fields && { fields: error.fields }),
    },
  })
}

/**
 * /api/v1 handler 래퍼: 캐시 금지 헤더를 붙이고 서비스 오류를 HTTP 오류로 바꿉니다.
 * handler는 입력 파싱 → 서비스 호출 → 응답 변환만 합니다.
 */
export function defineApiHandler<T>(handler: (event: H3Event) => Promise<T> | T) {
  return defineEventHandler(async (event) => {
    setResponseHeader(event, 'cache-control', 'no-store')
    try {
      return await handler(event)
    } catch (error) {
      throw toHttpError(error)
    }
  })
}

/** JSON 본문. 본문이 없거나 JSON이 아니면 빈 객체로 보고 스키마 검증(422)에 맡깁니다. */
export async function readJsonBody(event: H3Event): Promise<unknown> {
  try {
    return (await readBody(event)) ?? {}
  } catch {
    return {}
  }
}
