/**
 * 내부 API 인증(HMAC) 단위 테스트. DB 없이 h3 앱에 CSRF 미들웨어 + 내부 handler를 올려 확인합니다.
 */
import { createApp, defineEventHandler, toWebHandler } from 'h3'
import { describe, expect, it } from 'vitest'
import { MEETING_SUMMARY_MAX_BODY_BYTES, signRequest } from '@peerchive/bot-protocol'
import { createCsrfMiddleware, parseAllowedOrigins } from '../server/modules/security/csrf'
import {
  MAX_INTERNAL_BODY_BYTES,
  createInternalHandler,
  memoryNonceStore,
  resolveWebInternalSecret,
} from '../server/modules/discord/internal-auth'
import { discordInteractionClientId, discordMessageClientId, uuidV5 } from '../server/modules/discord/client-id'

const SECRET = 'f3a9c1e07b5d42868a1e9c3b7d0f6a25e8b4c2d19f7a6e30'
const ORIGIN = 'http://localhost:3000'
const PATH = '/api/internal/discord/logs'

function appWith(options: { secret?: string | null; now?: Date; maxBodyBytes?: number } = {}) {
  const app = createApp()
  const seen: unknown[] = []
  const store = memoryNonceStore()
  app.use(createCsrfMiddleware(() => parseAllowedOrigins(ORIGIN)))
  // 세션 미들웨어가 로그인 정보를 채운 상황을 흉내 냅니다(쿠키 로그인).
  app.use(
    defineEventHandler((event) => {
      event.context.auth = { sessionId: 's', user: { id: 'user-from-cookie' } }
    }),
  )
  app.use(
    PATH,
    createInternalHandler(
      {
        getSecret: () => (options.secret === undefined ? SECRET : options.secret),
        getNonceStore: () => store,
        now: () => options.now ?? new Date(),
        ...(options.maxBodyBytes && { maxBodyBytes: options.maxBodyBytes }),
      },
      async (event, body) => {
        seen.push({ body, auth: event.context.auth })
        return { status: 'created' }
      },
    ),
  )
  const handler = toWebHandler(app)
  const call = (init: { method?: string; headers?: Record<string, string>; body?: string; path?: string }) =>
    handler(
      new Request(`${ORIGIN}${init.path ?? PATH}`, {
        method: init.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: init.body,
      }),
    )
  return { call, seen }
}

const body = JSON.stringify({ interactionId: '1', text: 'CORS 에러' })
const signed = (overrides: { secret?: string; body?: string; path?: string; now?: Date; nonce?: string } = {}) =>
  signRequest(overrides.secret ?? SECRET, { method: 'POST', path: overrides.path ?? PATH, body: overrides.body ?? body }, overrides)

describe('internal API HMAC handler', () => {
  it('accepts a valid signature and ignores the cookie session', async () => {
    const { call, seen } = appWith()
    const res = await call({ headers: signed(), body })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'created' })
    expect(seen).toEqual([{ body: { interactionId: '1', text: 'CORS 에러' }, auth: null }])
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects cookie-only calls even with a same-site Origin (CSRF middleware does not cover /api/internal)', async () => {
    const { call, seen } = appWith()
    const res = await call({ headers: { cookie: 'peerchive_session=abc.def', origin: ORIGIN }, body })
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('invalid_signature')
    // Origin 없는 봇 요청도 CSRF 403이 아니라 서명으로만 판단합니다.
    expect((await call({ headers: signed(), body })).status).toBe(200)
    expect(seen).toHaveLength(1)
  })

  it('rejects oversized bodies before verifying the signature', async () => {
    const { call, seen } = appWith()
    const big = JSON.stringify({ interactionId: '1', text: 'x'.repeat(MAX_INTERNAL_BODY_BYTES) })
    const res = await call({ headers: signed({ body: big }), body: big })
    expect(res.status).toBe(413)
    expect(seen).toHaveLength(0)
  })

  it('a route can raise its own body cap (meeting summary 256KB, E-13) while the default stays 64KB; signature and nonce still apply', async () => {
    const mid = JSON.stringify({ interactionId: '1', messages: [{ content: '가'.repeat(40_000) }] })
    expect(Buffer.byteLength(mid)).toBeGreaterThan(MAX_INTERNAL_BODY_BYTES)
    // 기본 상한(64KB) 경로는 거부.
    expect((await appWith().call({ headers: signed({ body: mid }), body: mid })).status).toBe(413)
    const meeting = appWith({ maxBodyBytes: MEETING_SUMMARY_MAX_BODY_BYTES })
    const headers = signed({ body: mid })
    expect((await meeting.call({ headers, body: mid })).status).toBe(200)
    // 같은 nonce 재전송·서명 없는 요청은 여전히 401.
    expect((await meeting.call({ headers, body: mid })).status).toBe(401)
    expect((await meeting.call({ body: mid })).status).toBe(401)
    // 256KB를 넘으면 서명을 보기 전에 413.
    const huge = JSON.stringify({ interactionId: '1', text: 'x'.repeat(MEETING_SUMMARY_MAX_BODY_BYTES) })
    expect((await meeting.call({ headers: signed({ body: huge }), body: huge })).status).toBe(413)
    expect(meeting.seen).toHaveLength(1)
  })

  it('rejects a wrong secret, tampered body, other path and clock skew', async () => {
    const { call, seen } = appWith()
    expect((await call({ headers: signed({ secret: `${SECRET}x` }), body })).status).toBe(401)
    expect((await call({ headers: signed(), body: body.replace('CORS', 'XSS') })).status).toBe(401)
    expect((await call({ headers: signed({ path: '/api/internal/discord/pins' }), body })).status).toBe(401)
    const old = new Date(Date.now() - 6 * 60 * 1000)
    expect((await call({ headers: signed({ now: old }), body })).status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  it('rejects a replayed nonce', async () => {
    const { call, seen } = appWith()
    const headers = signed()
    expect((await call({ headers, body })).status).toBe(200)
    expect((await call({ headers, body })).status).toBe(401)
    expect(seen).toHaveLength(1)
  })

  it('returns 503 when no secret is configured and 405 for non-POST', async () => {
    expect((await appWith({ secret: null }).call({ headers: signed(), body })).status).toBe(503)
    expect((await appWith().call({ method: 'GET', headers: signed() })).status).toBe(405)
  })

  it('returns 422 for a signed body that is not JSON', async () => {
    const raw = 'not json'
    expect((await appWith().call({ headers: signed({ body: raw }), body: raw })).status).toBe(422)
  })
})

describe('internal secret configuration', () => {
  it('disables the API when unset and refuses weak secrets in production', () => {
    expect(resolveWebInternalSecret(undefined, { production: true })).toBeNull()
    expect(resolveWebInternalSecret('  ', { production: true })).toBeNull()
    expect(() => resolveWebInternalSecret('local-dev-only-change-me-0123456789abcdef', { production: true })).toThrow()
    expect(resolveWebInternalSecret(SECRET, { production: true })).toBe(SECRET)
    expect(resolveWebInternalSecret('local-dev-only-change-me-0123456789abcdef', { production: false })).toBeTruthy()
  })
})

describe('deterministic client ids', () => {
  it('derives stable RFC 9562 v5 UUIDs per Discord id', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
    expect(discordInteractionClientId('123')).toBe(discordInteractionClientId('123'))
    expect(discordInteractionClientId('123')).not.toBe(discordMessageClientId('123'))
    expect(discordMessageClientId('123')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
