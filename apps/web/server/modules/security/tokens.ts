/**
 * 토큰 생성·해시. 자체 암호 프로토콜을 만들지 않고 Node 표준 crypto만 씁니다.
 *
 * - 토큰은 CSPRNG 32바이트(256비트)를 base64url로 인코딩합니다.
 * - DB에는 SHA-256 해시(hex)만 저장합니다. 원문은 생성 직후 한 번만 사용자에게 전달합니다.
 * - 세션 secret 비교는 timingSafeEqual로 합니다. 매직링크·초대처럼 해시로 직접 조회하는 토큰은
 *   공격자가 해시 값을 고를 수 없으므로 조회 자체가 타이밍 오라클이 되지 않습니다(Lucia 가이드와 같은 판단).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 같은 길이의 hex 문자열을 상수 시간에 비교합니다. 길이가 다르면 false. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** URL·쿠키로 받은 토큰 형식 검사(base64url, 길이 제한). 형식이 틀리면 DB를 조회하지 않습니다. */
export function looksLikeToken(value: unknown, maxLength = 128): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value)
}
