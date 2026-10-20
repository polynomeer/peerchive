/**
 * 내부 API 요청 서명(HMAC-SHA256, ADR 0009). 디스코드 봇(apps/bot)이 서명하고 웹 서버(apps/web)가 검증합니다.
 * 자체 암호 기법을 만들지 않고 Node 표준 crypto의 HMAC·timingSafeEqual만 씁니다.
 *
 * 서명 대상(줄바꿈으로 이은 문자열):
 *   v1 \n <timestamp(초)> \n <nonce> \n <METHOD> \n <path(+query)> \n <본문 원문>
 * - timestamp가 서버 시각과 5분 넘게 차이 나면 거부합니다(skew).
 * - nonce는 요청마다 새로 만들며, 서버가 10분 동안 기억해 같은 nonce를 다시 받으면 거부합니다(replay).
 *   재시도도 새 nonce로 다시 서명합니다. 업무상 중복 방지는 별도(디스코드 interaction id → clientId)입니다.
 * - 메서드·경로까지 서명해 같은 본문을 다른 엔드포인트로 옮겨 보내는 것도 막습니다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_VERSION = 'v1'
export const HEADER_TIMESTAMP = 'x-peerchive-timestamp'
export const HEADER_NONCE = 'x-peerchive-nonce'
export const HEADER_SIGNATURE = 'x-peerchive-signature'
/** 허용 시각 차이(초). */
export const MAX_SKEW_SECONDS = 5 * 60
/** 서버가 nonce를 기억하는 시간(초). skew 창의 두 배라 창 안의 어떤 재전송도 걸러집니다. */
export const NONCE_TTL_SECONDS = 2 * MAX_SKEW_SECONDS
/** 공유 비밀 최소 길이(문자). `openssl rand -hex 32`(64자)를 권장합니다. */
export const MIN_SECRET_LENGTH = 32

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/

export interface SignedRequest {
  method: string
  /** 경로와 query(예: `/api/internal/discord/logs`). origin은 넣지 않습니다. */
  path: string
  /** 보낼 본문 원문 그대로(검증도 받은 원문으로 합니다). */
  body: string
}

export function canonicalString(timestamp: string, nonce: string, request: SignedRequest): string {
  return [SIGNATURE_VERSION, timestamp, nonce, request.method.toUpperCase(), request.path, request.body].join('\n')
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

export function generateNonce(): string {
  return randomBytes(18).toString('base64url')
}

/** 요청 헤더 3개를 만듭니다. timestamp·nonce는 테스트에서만 지정합니다. */
export function signRequest(
  secret: string,
  request: SignedRequest,
  options: { now?: Date; nonce?: string } = {},
): Record<string, string> {
  const timestamp = String(Math.floor((options.now ?? new Date()).getTime() / 1000))
  const nonce = options.nonce ?? generateNonce()
  return {
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: `${SIGNATURE_VERSION}=${hmacHex(secret, canonicalString(timestamp, nonce, request))}`,
  }
}

export type SignatureFailure = 'missing' | 'malformed' | 'skew' | 'bad_signature'
export type SignatureCheck = { ok: true; nonce: string; timestamp: number } | { ok: false; reason: SignatureFailure }

type HeaderValue = string | string[] | null | undefined

function single(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined
  return value ?? undefined
}

/**
 * 서명을 검증합니다(nonce 재사용 검사는 호출자가 저장소로 합니다). 실패 이유는 서버 로그·테스트용이며
 * 응답에는 구분 없이 401만 돌려줍니다.
 */
export function verifySignature(
  secret: string,
  headers: { timestamp: HeaderValue; nonce: HeaderValue; signature: HeaderValue },
  request: SignedRequest,
  now: Date = new Date(),
): SignatureCheck {
  if (!secret) return { ok: false, reason: 'bad_signature' }
  const timestamp = single(headers.timestamp)
  const nonce = single(headers.nonce)
  const signature = single(headers.signature)
  if (!timestamp || !nonce || !signature) return { ok: false, reason: 'missing' }
  if (!/^\d{1,12}$/.test(timestamp) || !NONCE_PATTERN.test(nonce)) return { ok: false, reason: 'malformed' }
  const match = SIGNATURE_PATTERN.exec(signature)
  if (!match?.[1]) return { ok: false, reason: 'malformed' }
  const seconds = Number(timestamp)
  if (Math.abs(now.getTime() / 1000 - seconds) > MAX_SKEW_SECONDS) return { ok: false, reason: 'skew' }
  const expected = Buffer.from(hmacHex(secret, canonicalString(timestamp, nonce, request)), 'hex')
  const given = Buffer.from(match[1], 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' }
  return { ok: true, nonce, timestamp: seconds }
}

/** 예시·문서에 쓰는 자리표시 값이 섞인 비밀은 production에서 받지 않습니다. */
const PLACEHOLDER_HINTS = ['change-me', 'changeme', 'example', 'placeholder', 'local-dev']

/** 공유 비밀이 충분히 강한지: 32자 이상, 서로 다른 문자 10개 이상, 자리표시 값 아님. */
export function isStrongSecret(secret: string | undefined | null): secret is string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false
  if (new Set(secret).size < 10) return false
  const lower = secret.toLowerCase()
  return !PLACEHOLDER_HINTS.some((hint) => lower.includes(hint))
}

/**
 * 설정값에서 공유 비밀을 고릅니다.
 * - production: 강한 비밀이 아니면 예외(그 프로세스는 시작하지 않음).
 * - 개발: 비어 있으면 null(내부 API 꺼짐), 짧아도 허용하되 16자 미만이면 예외.
 */
export function resolveInternalSecret(value: string | undefined, options: { production: boolean }): string | null {
  const secret = value?.trim() ?? ''
  if (options.production) {
    if (!isStrongSecret(secret)) {
      throw new Error(
        `PEERCHIVE_INTERNAL_SECRET must be a strong random value (>= ${MIN_SECRET_LENGTH} chars, not a placeholder) in production`,
      )
    }
    return secret
  }
  if (!secret) return null
  if (secret.length < 16) throw new Error('PEERCHIVE_INTERNAL_SECRET must be at least 16 characters')
  return secret
}
