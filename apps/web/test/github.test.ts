/**
 * E-11 GitHub App 단위 테스트(DB·네트워크 없음): 설정 해석(꺼짐), 앱 JWT(RS256), 웹훅 서명, fetch 클라이언트 요청 모양·토큰 캐시·폐기, 이벤트 해석.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppJwt, signWebhookBody, verifyWebhookSignature } from '../server/modules/github/app-auth'
import { createGithubClient } from '../server/modules/github/client'
import { githubAppConfig, githubEnabled, resolveGithubAppConfig, setGithubConfigForTesting } from '../server/modules/github/config'
import { firstLine, parseWebhookEvent } from '../server/modules/github/webhook'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_APP_WEBHOOK_SECRET: 'x'.repeat(40),
  GITHUB_APP_SLUG: 'peerchive',
  GITHUB_APP_CLIENT_ID: 'Iv1.abc',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
}
const NOW = new Date('2026-11-02T03:00:00Z')

describe('config', () => {
  afterEach(() => setGithubConfigForTesting(undefined))

  it('is off without any variable and when only some are set', () => {
    expect(resolveGithubAppConfig({}, { production: true })).toEqual({ config: null, problem: null })
    const partial = resolveGithubAppConfig({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'x' }, { production: false })
    expect(partial.config).toBeNull()
    expect(partial.problem).toContain('GITHUB_APP_PRIVATE_KEY')
    expect(partial.problem).not.toContain('client-secret')
  })

  it('accepts a full config, including PEM with escaped newlines', () => {
    const { config } = resolveGithubAppConfig({ ...ENV, GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') }, { production: true })
    expect(config).toMatchObject({ appId: '12345', slug: 'peerchive', clientId: 'Iv1.abc' })
  })

  it('rejects unreadable keys, non-numeric ids and short production webhook secrets', () => {
    expect(resolveGithubAppConfig({ ...ENV, GITHUB_APP_PRIVATE_KEY: 'not a key' }, { production: false }).config).toBeNull()
    expect(resolveGithubAppConfig({ ...ENV, GITHUB_APP_ID: 'abc' }, { production: false }).config).toBeNull()
    expect(resolveGithubAppConfig({ ...ENV, GITHUB_APP_SLUG: 'bad/slug' }, { production: false }).config).toBeNull()
    expect(resolveGithubAppConfig({ ...ENV, GITHUB_APP_WEBHOOK_SECRET: 'short' }, { production: true }).config).toBeNull()
    expect(resolveGithubAppConfig({ ...ENV, GITHUB_APP_WEBHOOK_SECRET: 'short' }, { production: false }).config).not.toBeNull()
  })

  it('feature is off by default in tests and follows the override', () => {
    setGithubConfigForTesting(null)
    expect(githubEnabled()).toBe(false)
    const { config } = resolveGithubAppConfig(ENV, { production: false })
    setGithubConfigForTesting(config)
    expect(githubAppConfig()).toBe(config)
    expect(githubEnabled()).toBe(true)
  })
})

describe('app JWT and webhook signature', () => {
  it('signs an RS256 JWT with iss = app id, iat 60 s in the past and exp within 10 minutes', () => {
    const jwt = createAppJwt('12345', privateKey, NOW)
    const [header, payload, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
    const now = Math.floor(NOW.getTime() / 1000)
    expect(claims).toEqual({ iss: '12345', iat: now - 60, exp: now + 540 })
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true)
  })

  it('verifies X-Hub-Signature-256 over the raw bytes only', () => {
    const body = Buffer.from('{"zen":"Keep it logically awesome."}')
    const header = signWebhookBody('secret', body)
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature('secret', body, header)).toBe(true)
    expect(verifyWebhookSignature('other', body, header)).toBe(false)
    expect(verifyWebhookSignature('secret', Buffer.from('{"zen": "Keep it logically awesome."}'), header)).toBe(false)
    expect(verifyWebhookSignature('secret', body, undefined)).toBe(false)
    expect(verifyWebhookSignature('secret', body, '')).toBe(false)
    expect(verifyWebhookSignature('secret', body, header.toUpperCase())).toBe(false)
    expect(verifyWebhookSignature('secret', body, `${header}00`)).toBe(false)
  })
})

describe('fetch client (mocked, no network)', () => {
  const config = resolveGithubAppConfig(ENV, { production: false }).config!

  function recorder(responses: Array<(url: string, init?: RequestInit) => Response>) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = []
    let i = 0
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: (init?.body as string) ?? null })
      const respond = responses[i++]
      if (!respond) throw new Error(`unexpected request ${url}`)
      return respond(url, init)
    }
    return { calls, fetch }
  }
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('gets an installation token with the app JWT, caches it in memory and revokes it on forget', async () => {
    const repo = { id: 7, full_name: 'team/capstone', html_url: 'https://github.com/team/capstone', private: true }
    const { calls, fetch } = recorder([
      json(201, { token: 'ghs_installation', expires_at: '2026-11-02T04:00:00Z' }),
      json(200, { total_count: 2, repositories: [repo, { id: 'bad' }] }),
      json(200, { total_count: 1, repositories: [repo] }),
      () => new Response(null, { status: 204 }),
    ])
    const client = createGithubClient(config, { fetch, now: () => NOW })
    expect(await client.listInstallationRepos(99)).toEqual([{ id: 7, fullName: 'team/capstone', htmlUrl: 'https://github.com/team/capstone', private: true }])
    await client.listInstallationRepos(99)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.github.com/app/installations/99/access_tokens',
      'GET https://api.github.com/installation/repositories?per_page=100&page=1',
      'GET https://api.github.com/installation/repositories?per_page=100&page=1',
    ])
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(calls[1]!.headers.authorization).toBe('Bearer ghs_installation')
    expect(calls[0]!.headers['x-github-api-version']).toBe('2022-11-28')
    await client.forgetInstallation(99)
    expect(calls[3]).toMatchObject({ method: 'DELETE', url: 'https://api.github.com/installation/token' })
    expect(calls[3]!.headers.authorization).toBe('Bearer ghs_installation')
    // 잊은 뒤에는 폐기할 토큰이 없어 요청하지 않습니다.
    await client.forgetInstallation(99)
    expect(calls).toHaveLength(4)
  })

  it('exchanges the OAuth code, reads the user and revokes the user token with basic auth', async () => {
    const { calls, fetch } = recorder([
      json(200, { access_token: 'ghu_user', token_type: 'bearer' }),
      json(200, { id: 4242, login: 'octo', email: 'must-not-be-used@example.com' }),
      json(404, { message: 'Not Found' }),
      () => new Response(null, { status: 204 }),
    ])
    const client = createGithubClient(config, { fetch, now: () => NOW })
    expect(await client.exchangeCode('code123', 'http://localhost:3100/api/v1/github/oauth/callback')).toBe('ghu_user')
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      client_id: 'Iv1.abc',
      client_secret: 'client-secret',
      code: 'code123',
      redirect_uri: 'http://localhost:3100/api/v1/github/oauth/callback',
    })
    expect(await client.getUser('ghu_user')).toEqual({ id: 4242, login: 'octo' })
    expect(await client.listUserInstallationRepos('ghu_user', 5)).toBeNull()
    expect(calls[2]!.url).toBe('https://api.github.com/user/installations/5/repositories?per_page=100&page=1')
    await client.revokeUserToken('ghu_user')
    expect(calls[3]).toMatchObject({ method: 'DELETE', url: 'https://api.github.com/applications/Iv1.abc/token' })
    expect(calls[3]!.headers.authorization).toBe(`Basic ${Buffer.from('Iv1.abc:client-secret').toString('base64')}`)
    expect(JSON.parse(calls[3]!.body!)).toEqual({ access_token: 'ghu_user' })
  })

  it('reports errors with status only and treats a missing installation as null', async () => {
    const { fetch } = recorder([json(404, {}), json(500, { message: 'secret detail' }), json(200, { error: 'bad_verification_code' })])
    const client = createGithubClient(config, { fetch, now: () => NOW })
    expect(await client.getInstallation(1)).toBeNull()
    const error = await client.getInstallation(2).catch((e: unknown) => e)
    expect(String(error)).toContain('500')
    expect(String(error)).not.toContain('secret detail')
    expect(await client.exchangeCode('bad', 'http://x')).toBeNull()
  })
})

describe('webhook event parsing', () => {
  it('keeps only the first line of messages, trimmed to 200 characters', () => {
    expect(firstLine('제목\n\n본문')).toBe('제목')
    expect(firstLine('  \n')).toBeNull()
    expect([...firstLine('a'.repeat(300))!]).toHaveLength(200)
    expect(firstLine('탭\t포함')).toBe('탭 포함')
  })

  it('parses push commits without file lists, emails or names', () => {
    const parsed = parseWebhookEvent('push', {
      installation: { id: 1 },
      repository: { id: 2 },
      sender: { id: 3, login: 'me' },
      commits: [
        { id: 'a'.repeat(40), distinct: true, message: 'one\ntwo', timestamp: '2026-11-02T00:00:00Z', url: 'https://github.com/o/r/commit/a', author: { email: 'e@x.com', name: 'N', username: 'me' }, added: ['f'] },
        { id: 'not-a-sha', message: 'x', timestamp: '2026-11-02T00:00:00Z', url: 'https://github.com/o/r/commit/b' },
        { id: 'b'.repeat(40), message: 'evil', timestamp: '2026-11-02T00:00:00Z', url: 'https://evil.example/commit/b' },
      ],
    })
    expect(parsed).toEqual({
      kind: 'push',
      installationId: 1,
      repoId: 2,
      sender: { id: 3, login: 'me' },
      commits: [{ sha: 'a'.repeat(40), title: 'one', url: 'https://github.com/o/r/commit/a', occurredAt: new Date('2026-11-02T00:00:00Z'), authorLogin: 'me' }],
    })
    expect(parseWebhookEvent('push', { repository: { id: 2 }, deleted: true, commits: [] })).toEqual({ kind: 'ignored' })
  })

  it('maps PR actions and lifecycle events, and ignores the rest', () => {
    const pr = { number: 3, title: 'T', html_url: 'https://github.com/o/r/pull/3', user: { id: 9 }, state: 'closed', merged: true, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' }
    expect(parseWebhookEvent('pull_request', { action: 'closed', repository: { id: 2 }, pull_request: pr })).toMatchObject({ kind: 'pull_request', number: 3, state: 'merged', authorId: 9 })
    expect(parseWebhookEvent('pull_request', { action: 'closed', repository: { id: 2 }, pull_request: { ...pr, merged: false, merged_at: null } })).toMatchObject({ state: 'closed' })
    expect(parseWebhookEvent('pull_request', { action: 'labeled', repository: { id: 2 }, pull_request: pr })).toEqual({ kind: 'ignored' })
    expect(parseWebhookEvent('installation', { action: 'deleted', installation: { id: 5 } })).toEqual({ kind: 'installation_removed', installationId: 5 })
    expect(parseWebhookEvent('installation', { action: 'created', installation: { id: 5 } })).toEqual({ kind: 'ignored' })
    expect(parseWebhookEvent('installation_repositories', { action: 'removed', installation: { id: 5 }, repositories_removed: [{ id: 8 }] })).toEqual({
      kind: 'repos_removed',
      installationId: 5,
      repoIds: [8],
    })
    expect(parseWebhookEvent('repository', { action: 'privatized', installation: { id: 5 }, repository: { id: 8 } })).toEqual({
      kind: 'repo_visibility',
      installationId: 5,
      repoId: 8,
      private: true,
    })
    expect(parseWebhookEvent('github_app_authorization', { action: 'revoked', sender: { id: 77 } })).toEqual({ kind: 'authorization_revoked', githubUserId: 77 })
    expect(parseWebhookEvent('issues', { action: 'opened' })).toEqual({ kind: 'ignored' })
  })
})
