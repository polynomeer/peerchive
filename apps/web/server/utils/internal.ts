import type { H3Event } from 'h3'
import { createInternalHandler, dbNonceStore, resolveWebInternalSecret } from '../modules/discord/internal-auth'

let secret: string | null | undefined

/**
 * 내부 API 공유 비밀(PEERCHIVE_INTERNAL_SECRET, 서버 전용). 비어 있으면 null이고 내부 API는 503입니다.
 * production에서 값이 있는데 약하면 예외(server/plugins/internal-api.ts가 시작 때 확인해 서버가 뜨지 않음).
 */
export function internalSecret(): string | null {
  if (secret === undefined) {
    secret = resolveWebInternalSecret(process.env.PEERCHIVE_INTERNAL_SECRET, { production: isProduction() })
  }
  return secret
}

/**
 * /api/internal handler 래퍼: HMAC 서명·nonce 확인 후 JSON 본문을 넘깁니다. 세션 쿠키는 보지 않습니다.
 * `maxBodyBytes`는 기본 64KB보다 큰 본문이 필요한 경로(회의 요약, E-13)만 넘깁니다.
 */
export function defineInternalApiHandler<T>(handler: (event: H3Event, body: unknown) => Promise<T>, options: { maxBodyBytes?: number } = {}) {
  return createInternalHandler(
    { getSecret: internalSecret, getNonceStore: () => dbNonceStore(requireDb()), mapError: toHttpError, ...options },
    handler,
  )
}
