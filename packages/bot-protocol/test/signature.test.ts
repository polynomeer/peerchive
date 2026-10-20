import { describe, expect, it } from 'vitest'
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  MAX_SKEW_SECONDS,
  isStrongSecret,
  resolveInternalSecret,
  signRequest,
  verifySignature,
} from '../src/index'

const secret = 'f3a9c1e07b5d42868a1e9c3b7d0f6a25e8b4c2d19f7a6e30'
const request = { method: 'POST', path: '/api/internal/discord/logs', body: '{"text":"CORS 에러"}' }
const now = new Date('2026-10-20T03:00:00Z')

const headersOf = (signed: Record<string, string>) => ({
  timestamp: signed[HEADER_TIMESTAMP],
  nonce: signed[HEADER_NONCE],
  signature: signed[HEADER_SIGNATURE],
})

describe('signRequest / verifySignature', () => {
  it('accepts a request signed with the same secret', () => {
    const signed = signRequest(secret, request, { now })
    const result = verifySignature(secret, headersOf(signed), request, now)
    expect(result).toMatchObject({ ok: true, nonce: signed[HEADER_NONCE] })
    expect(signed[HEADER_SIGNATURE]).toMatch(/^v1=[0-9a-f]{64}$/)
  })

  it('rejects a wrong secret, tampered body, method or path', () => {
    const signed = headersOf(signRequest(secret, request, { now }))
    expect(verifySignature(`${secret}x`, signed, request, now)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySignature(secret, signed, { ...request, body: '{"text":"CORS 에러!"}' }, now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
    expect(verifySignature(secret, signed, { ...request, path: '/api/internal/discord/pins' }, now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
    expect(verifySignature(secret, signed, { ...request, method: 'PUT' }, now)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifySignature('', signed, request, now)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects clock skew beyond 5 minutes in either direction', () => {
    const signed = headersOf(signRequest(secret, request, { now }))
    const later = (s: number) => new Date(now.getTime() + s * 1000)
    expect(verifySignature(secret, signed, request, later(MAX_SKEW_SECONDS)).ok).toBe(true)
    expect(verifySignature(secret, signed, request, later(MAX_SKEW_SECONDS + 1))).toEqual({ ok: false, reason: 'skew' })
    expect(verifySignature(secret, signed, request, later(-MAX_SKEW_SECONDS - 1))).toEqual({ ok: false, reason: 'skew' })
  })

  it('rejects missing or malformed headers', () => {
    const signed = headersOf(signRequest(secret, request, { now }))
    expect(verifySignature(secret, { ...signed, signature: undefined }, request, now)).toEqual({ ok: false, reason: 'missing' })
    expect(verifySignature(secret, { ...signed, nonce: 'short' }, request, now)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySignature(secret, { ...signed, signature: 'sha256=abc' }, request, now)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySignature(secret, { ...signed, timestamp: [signed.timestamp!, signed.timestamp!] }, request, now)).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  it('uses a fresh nonce for every signature', () => {
    const a = signRequest(secret, request, { now })
    const b = signRequest(secret, request, { now })
    expect(a[HEADER_NONCE]).not.toBe(b[HEADER_NONCE])
  })
})

describe('secret strength', () => {
  it('requires 32+ varied characters without placeholder words', () => {
    expect(isStrongSecret(secret)).toBe(true)
    expect(isStrongSecret('short')).toBe(false)
    expect(isStrongSecret('a'.repeat(64))).toBe(false)
    expect(isStrongSecret('local-dev-only-change-me-0123456789abcdef')).toBe(false)
  })

  it('refuses weak or missing secrets in production and tolerates an empty one in development', () => {
    expect(() => resolveInternalSecret('', { production: true })).toThrow(/PEERCHIVE_INTERNAL_SECRET/)
    expect(() => resolveInternalSecret('local-dev-only-change-me-0123456789abcdef', { production: true })).toThrow()
    expect(resolveInternalSecret(` ${secret} `, { production: true })).toBe(secret)
    expect(resolveInternalSecret(undefined, { production: false })).toBeNull()
    expect(resolveInternalSecret('local-dev-only-change-me-0123456789abcdef', { production: false })).toBe(
      'local-dev-only-change-me-0123456789abcdef',
    )
    expect(() => resolveInternalSecret('tooshort', { production: false })).toThrow()
  })
})
