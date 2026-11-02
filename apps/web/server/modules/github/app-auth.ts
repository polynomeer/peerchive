/**
 * GitHub App 인증 원시 함수(E-11, ADR 0056). 라이브러리 없이 `node:crypto`만 씁니다.
 *
 * - 앱 JWT(RS256): `iat`는 시계 차이를 감안해 60초 전, `exp`는 9분 뒤(GitHub 상한 10분), `iss`는 앱 id. 설치 토큰을 받을 때만 씁니다.
 * - 웹훅 서명: `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(웹훅 비밀, **받은 원문 바이트**). 형식이 틀리면 비교하지 않고 실패,
 *   비교는 같은 길이 버퍼의 `timingSafeEqual`(상수 시간)입니다. SHA-1 헤더(`X-Hub-Signature`)는 보지 않습니다.
 */
import { createHmac, createSign, timingSafeEqual, type KeyObject } from 'node:crypto'

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

export function createAppJwt(appId: string, privateKey: KeyObject, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat, exp: iat + 60 + 9 * 60, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`
}

export function signWebhookBody(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/

/** 서명 확인. 헤더가 없거나 형식이 틀리거나 값이 다르면 false. */
export function verifyWebhookSignature(secret: string, body: Buffer, header: string | null | undefined): boolean {
  if (typeof header !== 'string' || !SIGNATURE_PATTERN.test(header)) return false
  const expected = Buffer.from(signWebhookBody(secret, body), 'utf8')
  const actual = Buffer.from(header, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
