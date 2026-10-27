/**
 * S-06 링크 수집기(safeFetchHtml, ADR 0034). 바깥 인터넷에 나가지 않습니다: 이름은 가짜 resolver가 풀고, 실제 접속은 이 테스트가 연 127.0.0.1
 * 서버로만 갑니다. 테스트 훅은 127.0.0.1만 "추가 허용"하고 http·그 포트를 허용할 뿐이라 사설 주소 거부 규칙은 그대로입니다.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LINK_FETCH_POLICY, type ResolvedAddress, type SafeFetchTestHooks, safeFetchHtml } from '../src/net/safe-fetch'

let server: Server
let port = 0
const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers })
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=1' })
      res.end(body)
    }
    if (path === '/ok') return html('<a href="https://peerchive.example/u/kim">me</a>')
    const hop = /^\/hop(\d+)$/.exec(path)
    if (hop) {
      const n = Number(hop[1])
      res.writeHead(302, { location: n <= 1 ? '/ok' : `/hop${n - 1}` })
      return res.end()
    }
    if (path === '/to-ip') {
      res.writeHead(301, { location: `http://10.0.0.5:${port}/ok` })
      return res.end()
    }
    if (path === '/to-mapped') {
      res.writeHead(307, { location: `http://[::ffff:127.0.0.1]:${port}/ok` })
      return res.end()
    }
    if (path === '/to-internal-name') {
      res.writeHead(302, { location: `http://internal.peerchive-test.com:${port}/ok` })
      return res.end()
    }
    if (path === '/to-localhost') {
      res.writeHead(302, { location: `http://localhost:${port}/ok` })
      return res.end()
    }
    if (path === '/to-other-port') {
      res.writeHead(302, { location: `http://site.peerchive-test.com:${port + 1}/ok` })
      return res.end()
    }
    if (path === '/to-ftp') {
      res.writeHead(302, { location: 'ftp://site.peerchive-test.com/x' })
      return res.end()
    }
    if (path === '/to-same-host') {
      res.writeHead(302, { location: `http://rebind.peerchive-test.com:${port}/ok` })
      return res.end()
    }
    if (path === '/hang') return // 응답하지 않음
    if (path === '/slow-body') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html>')
      return // 본문을 끝내지 않음
    }
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' })
      const chunk = 'x'.repeat(64 * 1024)
      for (let i = 0; i < 10; i++) res.write(chunk)
      return res.end()
    }
    if (path === '/big-declared') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(10 * 1024 * 1024) })
      return res.end('x')
    }
    if (path === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"a":1}')
    }
    if (path === '/no-type') {
      res.writeHead(200)
      return res.end('<a href="x">')
    }
    if (path === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      return res.end('not really gzip')
    }
    if (path === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end('gone')
    }
    res.writeHead(500)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const LOCAL: ResolvedAddress = { address: '127.0.0.1', family: 4 }
const PRIVATE: ResolvedAddress = { address: '10.0.0.7', family: 4 }

function hooks(over: Partial<SafeFetchTestHooks> & { names?: Record<string, ResolvedAddress[] | (() => ResolvedAddress[])> } = {}) {
  const calls: string[] = []
  const connects: string[] = []
  const names: Record<string, ResolvedAddress[] | (() => ResolvedAddress[])> = {
    'site.peerchive-test.com': [LOCAL],
    'internal.peerchive-test.com': [PRIVATE],
    'mixed.peerchive-test.com': [LOCAL, PRIVATE],
    'mixed-v6.peerchive-test.com': [LOCAL, { address: 'fd00::1', family: 6 }],
    'mapped.peerchive-test.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
    ...over.names,
  }
  const h: SafeFetchTestHooks = {
    resolver: async (hostname) => {
      calls.push(hostname)
      const entry = names[hostname]
      if (!entry) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
      return typeof entry === 'function' ? entry() : entry
    },
    allowAddress: (a) => a === '127.0.0.1',
    policy: { schemes: ['http:'], ports: [port], timeoutMs: 1500 },
    onConnect: ({ address }) => connects.push(address),
    ...over,
  }
  return { h, calls, connects }
}

const at = (host: string, path: string) => `http://${host}:${port}${path}`

describe('safeFetchHtml — production policy rejects before any connection', () => {
  it('https only, port 443 only, no credentials, no IP literal, no internal names', async () => {
    const { h, calls } = hooks({ policy: {} }) // 정책은 운영 그대로, resolver만 가짜
    for (const [url, detail] of [
      ['http://github.com/a', 'scheme'],
      ['ftp://github.com/a', 'scheme'],
      ['https://github.com:8443/a', 'port'],
      ['https://u:p@github.com/a', 'credentials'],
      ['https://127.0.0.1/', 'ip_literal'],
      ['https://2130706433/', 'ip_literal'],
      ['https://0x7f.1/', 'ip_literal'],
      ['https://[::1]/', 'ip_literal'],
      ['https://[::ffff:169.254.169.254]/', 'ip_literal'],
      ['https://localhost/', 'host'],
      ['https://metadata.internal/', 'host'],
      ['https://printer.local/', 'host'],
    ] as const) {
      expect(await safeFetchHtml(url, { testHooks: h }), url).toEqual({ ok: false, error: 'blocked', detail })
    }
    expect(calls).toEqual([]) // DNS조차 묻지 않음
    expect(await safeFetchHtml('not a url', { testHooks: h })).toEqual({ ok: false, error: 'invalid_url' })
  })

  it('a public name that resolves to a private address is refused without connecting', async () => {
    const { h, connects } = hooks({ policy: {}, names: { 'github.com': [{ address: '169.254.169.254', family: 4 }] } })
    expect(await safeFetchHtml('https://github.com/someone', { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'address_private' })
    expect(connects).toEqual([])
  })

  it('production defaults: https/443, 3 redirects, 5s, 512KB, fixed UA', () => {
    expect(LINK_FETCH_POLICY).toMatchObject({ schemes: ['https:'], ports: [443], maxRedirects: 3, timeoutMs: 5000, maxBytes: 512 * 1024 })
    expect(Object.isFrozen(LINK_FETCH_POLICY)).toBe(true)
  })

  it('test hooks cannot be used outside NODE_ENV=test', async () => {
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(safeFetchHtml('https://github.com/', { testHooks: {} })).rejects.toThrow(/only allowed under NODE_ENV=test/)
    } finally {
      process.env.NODE_ENV = before
    }
  })
})

describe('safeFetchHtml — against a local test server', () => {
  it('fetches HTML, sends a fixed UA, no cookies, identity encoding, the original Host', async () => {
    const { h } = hooks()
    seen.length = 0
    const r = await safeFetchHtml(at('site.peerchive-test.com', '/ok'), { testHooks: h })
    expect(r).toEqual({ ok: true, url: at('site.peerchive-test.com', '/ok'), status: 200, body: '<a href="https://peerchive.example/u/kim">me</a>' })
    expect(seen[0]!.headers['user-agent']).toBe(LINK_FETCH_POLICY.userAgent)
    expect(seen[0]!.headers['accept-encoding']).toBe('identity')
    expect(seen[0]!.headers.host).toBe(`site.peerchive-test.com:${port}`)
    expect(seen[0]!.headers.cookie).toBeUndefined()
  })

  it('follows up to 3 redirects, re-validating each hop; the 4th is refused', async () => {
    const { h, calls } = hooks()
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/hop3'), { testHooks: h })).toMatchObject({ ok: true, url: at('site.peerchive-test.com', '/ok') })
    expect(calls).toHaveLength(4) // 매 hop마다 다시 해석·검사
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/hop4'), { testHooks: h })).toEqual({ ok: false, error: 'too_many_redirects' })
  })

  it('a redirect to a private IP literal, an IPv4-mapped literal, a name resolving privately, localhost, another port or another scheme is refused', async () => {
    const { h, connects } = hooks()
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/to-ip'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'ip_literal' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/to-mapped'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'ip_literal' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/to-internal-name'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'address_private' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/to-localhost'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'host' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/to-other-port'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'port' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/to-ftp'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'scheme' })
    // 접속은 첫 hop(127.0.0.1)뿐이고 사설 주소로는 한 번도 가지 않음.
    expect(connects.every((a) => a === '127.0.0.1')).toBe(true)
  })

  it('DNS answers mixing an allowed and a private address are refused (IPv4 and IPv6), IPv4-mapped answers too', async () => {
    const { h, connects } = hooks()
    expect(await safeFetchHtml(at('mixed.peerchive-test.com', '/ok'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'address_private' })
    expect(await safeFetchHtml(at('mixed-v6.peerchive-test.com', '/ok'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'address_private' })
    expect(await safeFetchHtml(at('mapped.peerchive-test.com', '/ok'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'address_private' })
    expect(await safeFetchHtml(at('nxdomain.peerchive-test.com', '/ok'), { testHooks: h })).toEqual({ ok: false, error: 'dns' })
    expect(connects).toEqual([])
  })

  it('DNS rebinding: the socket uses the vetted (pinned) address, and a later hop that now resolves privately is refused', async () => {
    let n = 0
    const flip = () => (n++ === 0 ? [LOCAL] : [PRIVATE])
    const { h, calls, connects } = hooks({ names: { 'rebind.peerchive-test.com': flip } })
    // 이 이름은 시스템 DNS에 없습니다. 소켓이 자기 lookup을 했다면 ENOTFOUND였을 것 — 성공은 고정된 주소로 접속했다는 뜻입니다.
    expect(await safeFetchHtml(at('rebind.peerchive-test.com', '/ok'), { testHooks: h })).toMatchObject({ ok: true, status: 200 })
    expect(calls).toEqual(['rebind.peerchive-test.com'])
    expect(connects).toEqual(['127.0.0.1'])
    // 같은 이름으로 redirect된 다음 hop은 다시 해석해 이번엔 사설 주소 → 거부.
    n = 0
    expect(await safeFetchHtml(at('rebind.peerchive-test.com', '/to-same-host'), { testHooks: h })).toEqual({ ok: false, error: 'blocked', detail: 'address_private' })
  })

  it('total timeout covers a hanging server and a stalled body', async () => {
    const { h } = hooks({ policy: { schemes: ['http:'], ports: [port], timeoutMs: 300 } })
    const started = Date.now()
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/hang'), { testHooks: h })).toEqual({ ok: false, error: 'timeout' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/slow-body'), { testHooks: h })).toEqual({ ok: false, error: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3000)
    const slowDns = hooks({ policy: { schemes: ['http:'], ports: [port], timeoutMs: 200 }, resolver: () => new Promise(() => {}) })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/ok'), { testHooks: slowDns.h })).toEqual({ ok: false, error: 'timeout' })
  })

  it('caps the body size (streamed and declared), accepts only HTML without content-encoding, and reports non-2xx', async () => {
    const { h } = hooks()
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/big'), { testHooks: h })).toEqual({ ok: false, error: 'too_large' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/big-declared'), { testHooks: h })).toEqual({ ok: false, error: 'too_large' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/json'), { testHooks: h })).toEqual({ ok: false, error: 'not_html', detail: 'application/json' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/no-type'), { testHooks: h })).toEqual({ ok: false, error: 'not_html', detail: 'missing' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/gzip'), { testHooks: h })).toEqual({ ok: false, error: 'not_html', detail: 'encoding_gzip' })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/missing'), { testHooks: h })).toEqual({ ok: false, error: 'http_status', status: 404 })
    expect(await safeFetchHtml(at('site.peerchive-test.com', '/error'), { testHooks: h })).toEqual({ ok: false, error: 'http_status', status: 500 })
  })
})
