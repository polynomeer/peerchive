import { createApp, defineEventHandler, toWebHandler } from 'h3'
import { describe, expect, it } from 'vitest'
import {
  createCsrfMiddleware,
  isSameSiteRequest,
  parseAllowedOrigins,
  requiresCsrfCheck,
} from '../server/modules/security/csrf'

const allowed = parseAllowedOrigins('http://localhost:3000, https://peerchive.example')

describe('parseAllowedOrigins', () => {
  it('normalizes and drops invalid entries', () => {
    expect(parseAllowedOrigins('https://a.example/path, null, , ftp://x, not a url')).toEqual(['https://a.example'])
    expect(allowed).toEqual(['http://localhost:3000', 'https://peerchive.example'])
  })
})

describe('isSameSiteRequest', () => {
  const post = { method: 'POST', path: '/api/v1/projects' }

  it('only checks state-changing /api/v1 requests', () => {
    expect(requiresCsrfCheck('GET', '/api/v1/projects')).toBe(false)
    expect(requiresCsrfCheck('HEAD', '/api/v1/projects')).toBe(false)
    expect(requiresCsrfCheck('POST', '/login')).toBe(false)
    expect(requiresCsrfCheck('POST', '/api/v10/x')).toBe(false)
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'delete']) {
      expect(requiresCsrfCheck(method, '/api/v1/projects/1')).toBe(true)
    }
    expect(isSameSiteRequest({ method: 'GET', path: '/api/v1/me' }, allowed)).toBe(true)
  })

  it('accepts a matching Origin', () => {
    expect(isSameSiteRequest({ ...post, origin: 'http://localhost:3000' }, allowed)).toBe(true)
    expect(isSameSiteRequest({ ...post, origin: 'https://peerchive.example' }, allowed)).toBe(true)
  })

  it('rejects a foreign, null or look-alike Origin even with a valid Referer', () => {
    expect(isSameSiteRequest({ ...post, origin: 'https://evil.example' }, allowed)).toBe(false)
    expect(isSameSiteRequest({ ...post, origin: 'null', referer: 'http://localhost:3000/x' }, allowed)).toBe(false)
    expect(isSameSiteRequest({ ...post, origin: 'http://localhost:3001' }, allowed)).toBe(false)
    expect(isSameSiteRequest({ ...post, origin: 'https://peerchive.example.evil.example' }, allowed)).toBe(false)
    expect(isSameSiteRequest({ ...post, origin: 'http://peerchive.example' }, allowed)).toBe(false)
  })

  it('falls back to Referer when Origin is absent', () => {
    expect(isSameSiteRequest({ ...post, referer: 'http://localhost:3000/projects/1' }, allowed)).toBe(true)
    expect(isSameSiteRequest({ ...post, referer: 'https://evil.example/?http://localhost:3000' }, allowed)).toBe(false)
  })

  it('rejects when both headers are missing or nothing is configured', () => {
    expect(isSameSiteRequest(post, allowed)).toBe(false)
    expect(isSameSiteRequest({ ...post, origin: 'http://localhost:3000' }, [])).toBe(false)
  })
})

describe('CSRF middleware in an h3 app', () => {
  const app = createApp()
  app.use(createCsrfMiddleware(() => allowed))
  app.use(defineEventHandler(() => ({ ok: true })))
  const handler = toWebHandler(app)
  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    handler(new Request(`http://localhost:3000${path}`, { method, headers }))

  it('returns 403 for a cross-site POST', async () => {
    const res = await call('POST', '/api/v1/projects', { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('csrf_origin_mismatch')
  })

  it('returns 403 for a DELETE without Origin/Referer', async () => {
    expect((await call('DELETE', '/api/v1/projects/x/members/y')).status).toBe(403)
  })

  it('passes same-origin writes and all reads', async () => {
    expect((await call('PATCH', '/api/v1/me/profile', { origin: 'http://localhost:3000' })).status).toBe(200)
    expect((await call('POST', '/api/v1/auth/logout', { referer: 'http://localhost:3000/projects' })).status).toBe(200)
    expect((await call('GET', '/api/v1/projects', { origin: 'https://evil.example' })).status).toBe(200)
  })

  it('ignores the query string when matching the path', async () => {
    expect((await call('POST', '/api/v1/projects?x=1')).status).toBe(403)
  })
})
