/**
 * S-06 소셜 링크 되돌림 확인·재확인(ADR 0034). payload·결과 분류는 DB 없이, 확인·재확인은 실제 PostgreSQL(rollback)로 봅니다.
 * 바깥 인터넷에 나가지 않습니다: 가짜 fetch, 또는 127.0.0.1 테스트 서버 + 가짜 resolver(시나리오 V).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SOCIAL_LINK_VERIFY_TOPIC,
  analyticsEvents,
  createDb,
  eq,
  hashSubject,
  outboxEvents,
  personas,
  socialLinks,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { SOCIAL_LINK_MAX_FAILURES } from '@peerchive/domain'
import { dispatchOutbox } from '../src/dispatcher'
import type { SafeFetchResult } from '../src/net/safe-fetch'
import { safeFetchHtml } from '../src/net/safe-fetch'
import { checkSocialLink, classifyFetch, parseSocialLinkPayload, recheckSocialLinks } from '../src/social-links'
import { DEFAULT_CRONS, loadOpsConfig, siteOriginFrom } from '../src/ops/config'

const ORIGIN = 'https://peerchive.example'
const id = () => crypto.randomUUID()

describe('social link payloads and fetch classification', () => {
  it('accepts a link id only', () => {
    const linkId = id()
    expect(parseSocialLinkPayload({ socialLinkId: linkId.toUpperCase(), url: 'https://x' })).toEqual({ socialLinkId: linkId })
    expect(parseSocialLinkPayload({ socialLinkId: 'nope' })).toBeNull()
    expect(parseSocialLinkPayload(null)).toBeNull()
  })

  it('maps fetch results: back-link found/missing, 404/410 = missing, blocked vs other failures', () => {
    const profile = `${ORIGIN}/u/kim`
    const page = (body: string): SafeFetchResult => ({ ok: true, url: 'https://github.com/kim', status: 200, body })
    expect(classifyFetch(page(`<a href="${profile}">`), profile)).toEqual({ outcome: 'found', code: 'found' })
    expect(classifyFetch(page('<a href="https://elsewhere.example.com">'), profile)).toEqual({ outcome: 'missing', code: 'missing' })
    expect(classifyFetch({ ok: false, error: 'http_status', status: 404 }, profile)).toEqual({ outcome: 'missing', code: 'missing' })
    expect(classifyFetch({ ok: false, error: 'http_status', status: 410 }, profile)).toEqual({ outcome: 'missing', code: 'missing' })
    expect(classifyFetch({ ok: false, error: 'http_status', status: 503 }, profile)).toEqual({ outcome: 'error', code: 'fetch_failed' })
    expect(classifyFetch({ ok: false, error: 'blocked', detail: 'address_private' }, profile)).toEqual({ outcome: 'error', code: 'blocked' })
    expect(classifyFetch({ ok: false, error: 'timeout' }, profile)).toEqual({ outcome: 'error', code: 'fetch_failed' })
  })

  it('the recheck runs hourly by default and reads the site origin from NUXT_SITE_ORIGIN (first entry)', () => {
    expect(DEFAULT_CRONS['social-link-recheck']).toBe('37 * * * *')
    expect(siteOriginFrom({ NUXT_SITE_ORIGIN: ' https://peerchive.example/ , http://localhost:3000' })).toBe('https://peerchive.example')
    expect(siteOriginFrom({ NUXT_SITE_ORIGIN: 'null,ftp://x' })).toBeNull()
    expect(loadOpsConfig({ NODE_ENV: 'test' }).siteOrigin).toBeNull()
  })
})

const url = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!url)('social link verification (PostgreSQL)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined
  let server: Server
  let port = 0
  // 시나리오 V의 "GitHub 프로필": 처음에는 되돌림 링크가 있고, 사용자가 지우면 없어집니다.
  let githubHasBackLink = true
  let handleOnPage = ''
  const connects: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirects-inside') {
        res.writeHead(302, { location: `http://10.0.0.5:${port}/kim` })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(githubHasBackLink ? `<div class="profile"><a rel="nofollow me" href="${ORIGIN}/u/${handleOnPage}">Peerchive</a></div>` : '<div class="profile"></div>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await db?.$client.end()
  })

  /** 저장된 https 주소를 로컬 http 테스트 서버로 바꿔 safeFetchHtml(테스트 훅)로 가져옵니다. 이름은 가짜 resolver가 풉니다. */
  const localFetch = (stored: string) =>
    safeFetchHtml(stored.replace(/^https:\/\/([^/]+)/, `http://$1:${port}`), {
      testHooks: {
        resolver: async (hostname) => {
          if (hostname === 'github.peerchive-test.com') return [{ address: '127.0.0.1', family: 4 }]
          throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
        },
        allowAddress: (a) => a === '127.0.0.1',
        policy: { schemes: ['http:'], ports: [port], timeoutMs: 2000 },
        onConnect: ({ address }) => connects.push(address),
      },
    })

  async function rollback(fn: (tx: DbExecutor) => Promise<void>) {
    await expect(
      db!.transaction(async (tx) => {
        await fn(tx)
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  async function persona(tx: DbExecutor, kind: 'real' | 'display' = 'real') {
    const [user] = await tx.insert(users).values({ displayName: '링크', privateEmail: `l+${id()}@example.test` }).returning()
    const [p] = await tx
      .insert(personas)
      .values({ userId: user!.id, kind, handle: `sl-${id().slice(0, 8)}`, ...(kind === 'display' && { displayName: '표시' }) })
      .returning()
    return p!
  }

  async function link(tx: DbExecutor, p: { id: string; userId: string }, over: Partial<typeof socialLinks.$inferInsert> = {}) {
    const [row] = await tx
      .insert(socialLinks)
      .values({ personaId: p.id, userId: p.userId, provider: 'github', url: `https://github.com/${id().slice(0, 6)}`, ...over })
      .returning()
    return row!
  }

  const get = async (tx: DbExecutor, linkId: string) => (await tx.select().from(socialLinks).where(eq(socialLinks.id, linkId)))[0]!

  const page = (body: string) => async (u: string): Promise<SafeFetchResult> => ({ ok: true, url: u, status: 200, body })

  it('verify: a page linking back to /u/<handle> becomes verified with verified_at; a page without stays unverified', async () => {
    await rollback(async (tx) => {
      const p = await persona(tx)
      const l = await link(tx, p)
      const now = new Date('2026-10-28T00:00:00Z')
      expect(await checkSocialLink(tx, l.id, { siteOrigin: ORIGIN, fetchHtml: page('<a href="https://elsewhere.example.com">') }, now)).toEqual({
        id: l.id,
        verification: 'unverified',
        result: 'missing',
      })
      expect(await get(tx, l.id)).toMatchObject({ verification: 'unverified', verifiedAt: null, lastCheckedAt: now, lastCheckResult: 'missing' })
      // 다른 페르소나(같은 사용자의 표시명 등)의 handle로 가는 링크는 이 링크를 확인하지 않습니다.
      expect((await checkSocialLink(tx, l.id, { siteOrigin: ORIGIN, fetchHtml: page(`<a href="${ORIGIN}/u/someone-else">`) }, now))!.verification).toBe('unverified')
      const later = new Date('2026-10-28T01:00:00Z')
      expect((await checkSocialLink(tx, l.id, { siteOrigin: ORIGIN, fetchHtml: page(`<a href="${ORIGIN}/u/${p.handle}/">`) }, later))!.verification).toBe('verified')
      expect(await get(tx, l.id)).toMatchObject({ verification: 'verified', verifiedAt: later, lastCheckedAt: later, lastCheckResult: 'found', checkFailures: 0 })
    })
  })

  it('S-07 §6.2: becoming verified records social_link_verified once (owner key, provider only, hour bucket); rechecks and opt-out record nothing', async () => {
    await rollback(async (tx) => {
      const pepper = 'worker-s07-analytics-pepper-0123456789abcdef'
      const p = await persona(tx, 'display')
      const l = await link(tx, p)
      const found = page(`<a href="${ORIGIN}/u/${p.handle}">`)
      const events = () => tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(pepper, p.userId)))
      await checkSocialLink(tx, l.id, { siteOrigin: ORIGIN, fetchHtml: found, analyticsPepper: pepper }, new Date('2026-10-28T05:42:10Z'))
      await checkSocialLink(tx, l.id, { siteOrigin: ORIGIN, fetchHtml: found, analyticsPepper: pepper }, new Date('2026-10-29T05:42:10Z'))
      const rows = await events()
      expect(rows.map((r) => ({ name: r.name, props: r.props, at: r.occurredAt.toISOString() }))).toEqual([
        { name: 'social_link_verified', props: { provider: 'github' }, at: '2026-10-28T05:00:00.000Z' },
      ])
      // 주소·페르소나 id는 이벤트에 없습니다.
      expect(JSON.stringify(rows)).not.toContain(l.url)
      expect(JSON.stringify(rows)).not.toContain(p.id)
      const q = await link(tx, p, { url: `https://blog.example.com/${id().slice(0, 6)}`, provider: 'blog' })
      await tx.update(users).set({ analyticsOptOut: true }).where(eq(users.id, p.userId))
      await checkSocialLink(tx, q.id, { siteOrigin: ORIGIN, fetchHtml: found, analyticsPepper: pepper }, new Date('2026-10-30T00:00:00Z'))
      expect(await events()).toHaveLength(1)
    })
  })

  it('does not fetch without a site origin, for deleted links, or for deactivated personas', async () => {
    await rollback(async (tx) => {
      const p = await persona(tx)
      const l = await link(tx, p)
      let fetched = 0
      const fetchHtml = async (u: string): Promise<SafeFetchResult> => {
        fetched++
        return { ok: true, url: u, status: 200, body: '' }
      }
      expect(await checkSocialLink(tx, l.id, { siteOrigin: null, fetchHtml })).toBeNull()
      expect(await checkSocialLink(tx, id(), { siteOrigin: ORIGIN, fetchHtml })).toBeNull()
      await tx.update(personas).set({ status: 'deactivated' }).where(eq(personas.id, p.id))
      expect(await checkSocialLink(tx, l.id, { siteOrigin: ORIGIN, fetchHtml })).toBeNull()
      expect(fetched).toBe(0)
      expect(await recheckSocialLinks(tx, { siteOrigin: null, fetchHtml }, { now: new Date() })).toMatchObject({ affected: 0, halted: 'no_site_origin' })
    })
  })

  it('recheck: verified links older than 24h are re-fetched; a missing back-link turns them lost; recent ones are skipped', async () => {
    await rollback(async (tx) => {
      const now = new Date('2026-11-01T00:00:00Z')
      const old = new Date('2026-10-30T00:00:00Z')
      const p = await persona(tx)
      const stale = await link(tx, p, { verification: 'verified', verifiedAt: old, lastCheckedAt: old })
      const fresh = await link(tx, p, { verification: 'verified', verifiedAt: old, lastCheckedAt: new Date('2026-10-31T12:00:00Z') })
      const unverified = await link(tx, p, { lastCheckedAt: old })
      const fetchedUrls: string[] = []
      const fetchHtml = async (u: string): Promise<SafeFetchResult> => {
        fetchedUrls.push(u)
        return { ok: true, url: u, status: 200, body: '<p>no link here</p>' }
      }
      // 다른 테스트·개발 DB의 행과 섞이지 않게 이 페르소나의 링크만 보도록 limit을 넉넉히 두고 결과는 행으로 확인합니다.
      await recheckSocialLinks(tx, { siteOrigin: ORIGIN, fetchHtml }, { now, limit: 1000 })
      expect(fetchedUrls).toContain(stale.url)
      expect(fetchedUrls).not.toContain(fresh.url)
      expect(fetchedUrls).not.toContain(unverified.url)
      expect(await get(tx, stale.id)).toMatchObject({ verification: 'lost', verifiedAt: null, lastCheckedAt: now, lastCheckResult: 'missing' })
      expect((await get(tx, fresh.id)).verification).toBe('verified')
    })
  })

  it(`recheck: fetch errors keep the state and count; ${SOCIAL_LINK_MAX_FAILURES} consecutive failures turn verified into lost; success resets the count`, async () => {
    await rollback(async (tx) => {
      const p = await persona(tx)
      const start = new Date('2026-11-01T00:00:00Z')
      const l = await link(tx, p, { verification: 'verified', verifiedAt: start, lastCheckedAt: start })
      const failing = async (): Promise<SafeFetchResult> => ({ ok: false, error: 'timeout' })
      const day = (n: number) => new Date(start.getTime() + n * 25 * 60 * 60 * 1000)
      await recheckSocialLinks(tx, { siteOrigin: ORIGIN, fetchHtml: failing }, { now: day(1), limit: 1000 })
      expect(await get(tx, l.id)).toMatchObject({ verification: 'verified', checkFailures: 1, lastCheckResult: 'fetch_failed', verifiedAt: start })
      // 성공하면 0으로.
      await recheckSocialLinks(tx, { siteOrigin: ORIGIN, fetchHtml: page(`<a href="${ORIGIN}/u/${p.handle}">`) }, { now: day(2), limit: 1000 })
      expect(await get(tx, l.id)).toMatchObject({ verification: 'verified', checkFailures: 0, verifiedAt: start })
      for (let i = 0; i < SOCIAL_LINK_MAX_FAILURES; i++) await recheckSocialLinks(tx, { siteOrigin: ORIGIN, fetchHtml: failing }, { now: day(3 + i), limit: 1000 })
      expect(await get(tx, l.id)).toMatchObject({ verification: 'lost', checkFailures: SOCIAL_LINK_MAX_FAILURES, verifiedAt: null })
    })
  })

  it('scenario V end to end: verify request (outbox) → worker fetch through the guarded fetcher → verified; back-link removed → next recheck lost; a redirect to a private IP is never connected', async () => {
    await rollback(async (tx) => {
      const p = await persona(tx)
      handleOnPage = p.handle
      githubHasBackLink = true
      connects.length = 0
      const l = await link(tx, p, { url: 'https://github.peerchive-test.com/kim' })
      // 웹의 POST /social-links/:id/verify가 남기는 것과 같은 outbox 행.
      await tx.insert(outboxEvents).values({ topic: SOCIAL_LINK_VERIFY_TOPIC, payload: { socialLinkId: l.id } })
      const t0 = new Date('2026-11-01T00:00:00Z')
      const handled: string[] = []
      await dispatchOutbox(tx, async (queue, data) => {
        if (queue !== SOCIAL_LINK_VERIFY_TOPIC) return
        const payload = parseSocialLinkPayload(data)
        if (payload?.socialLinkId !== l.id) return
        handled.push(queue)
        await checkSocialLink(tx, payload.socialLinkId, { siteOrigin: ORIGIN, fetchHtml: localFetch }, t0)
      })
      expect(handled).toEqual([SOCIAL_LINK_VERIFY_TOPIC])
      expect(await get(tx, l.id)).toMatchObject({ verification: 'verified', verifiedAt: t0, lastCheckResult: 'found' })

      // 사용자가 GitHub에서 링크를 지움 → 다음 재확인(24시간 뒤)에서 lost.
      githubHasBackLink = false
      const t1 = new Date(t0.getTime() + 25 * 60 * 60 * 1000)
      await recheckSocialLinks(tx, { siteOrigin: ORIGIN, fetchHtml: localFetch }, { now: t1, limit: 1000 })
      expect(await get(tx, l.id)).toMatchObject({ verification: 'lost', verifiedAt: null, lastCheckedAt: t1, lastCheckResult: 'missing' })

      // 사설 IP로 redirect되는 주소: 수집기가 접속하지 않고 거부(blocked), 상태는 그대로.
      const inside = await link(tx, p, { url: 'https://github.peerchive-test.com/redirects-inside' })
      connects.length = 0
      expect(await checkSocialLink(tx, inside.id, { siteOrigin: ORIGIN, fetchHtml: localFetch }, t1)).toEqual({ id: inside.id, verification: 'unverified', result: 'blocked' })
      expect(connects).toEqual(['127.0.0.1'])
      expect(await get(tx, inside.id)).toMatchObject({ verification: 'unverified', checkFailures: 1, lastCheckResult: 'blocked' })
    })
  })
})
