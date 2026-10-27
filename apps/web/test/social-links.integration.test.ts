/**
 * S-06 소셜 링크·되돌림 확인 요청 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * SYSTEM_DESIGN §6.7.1 SocialLink·§8.3 "프로필 기본 정보" 줄·§9.2, DELIVERY_PLAN §5.2 V(웹 쪽: 링크·확인 요청·공개 표시), ADR 0034.
 * 웹은 링크 주소에 접속하지 않으므로 이 테스트도 네트워크를 쓰지 않습니다(확인 결과는 worker 테스트가 봄; 여기서는 행을 직접 바꿔 공개 표시를 봄).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { SOCIAL_LINK_LIMIT, SOCIAL_LINK_VERIFY_LINK_RATE_LIMIT } from '@peerchive/domain'
import { SOCIAL_LINK_VERIFY_TOPIC, and, auditEvents, eq, inArray, outboxEvents, personas, socialLinks, sql, type DbExecutor } from '@peerchive/db'
import { upsertProfile } from '../server/modules/identity/profiles'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createBlock } from '../server/modules/social/blocks'
import { getProfileSocial } from '../server/modules/social/follows'
import { createDisplayPersona, listMyPersonas, setIdentityLink } from '../server/modules/social/personas'
import { addSocialLink, listMySocialLinks, publicSocialLinks, removeSocialLink, requestSocialLinkVerification } from '../server/modules/social/social-links'
import { closeTestDb, createUser, databaseUrl, expectServiceError, withRollback } from './helpers'

const T0 = new Date('2026-11-25T09:00:00Z')
const ORIGIN = 'https://peerchive.example'
const tag = () => crypto.randomUUID().slice(0, 8)

async function person(db: DbExecutor, label: string, opts: { display?: boolean } = {}) {
  const t = tag()
  const user = await createUser(db, { displayName: '임시' })
  const actor = { userId: user.id }
  const realHandle = `sl-${t}`
  await upsertProfile(db, actor, { handle: realHandle, displayName: `${label}${t}` })
  const realId = (await listMyPersonas(db, actor)).personas.find((p) => p.kind === 'real')!.id
  let display: { id: string; handle: string } | null = null
  if (opts.display) {
    const handle = `sld-${t}`
    display = { id: (await createDisplayPersona(db, actor, { handle, displayName: `별명${t}` }, T0)).id, handle }
  }
  return { user, actor, realHandle, realId, display }
}

describe.skipIf(!databaseUrl)('S-06 social links (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('add (normalized, unverified) → list with the back-link URL → public profile shows it → remove; nothing fetched, no outbox until verify', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '링크')
      const [{ n: outboxBefore }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(outboxEvents)) as [{ n: number }]
      const link = await addSocialLink(tx, A.actor, A.realId, { provider: 'github', url: ' https://GitHub.com/kim#top ' }, T0)
      expect(link).toEqual({
        id: link.id,
        provider: 'github',
        url: 'https://github.com/kim',
        verification: 'unverified',
        verifiedAt: null,
        lastCheckedAt: null,
        lastCheckResult: null,
        verifyPending: false,
        createdAt: T0.toISOString(),
      })
      expect(await listMySocialLinks(tx, A.actor, A.realId, ORIGIN)).toEqual({ links: [link], limit: SOCIAL_LINK_LIMIT, backLinkUrl: `${ORIGIN}/u/${A.realHandle}` })
      expect((await getPublicPortfolioProfile(tx, A.realHandle, T0)).socialLinks).toEqual([{ provider: 'github', url: 'https://github.com/kim', verified: false }])
      const [{ n: outboxAfter }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(outboxEvents)) as [{ n: number }]
      expect(outboxAfter).toBe(outboxBefore)

      expect(await removeSocialLink(tx, A.actor, link.id)).toEqual({ removed: true })
      expect((await getPublicPortfolioProfile(tx, A.realHandle, T0)).socialLinks).toEqual([])
      await expectServiceError(removeSocialLink(tx, A.actor, link.id), 'NOT_FOUND')
    })
  })

  it('validates the URL (https only, no credentials/IP/internal names, provider host) and the provider', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '검사')
      const cases: Array<[unknown, unknown, string]> = [
        ['github', 'http://github.com/kim', 'scheme'],
        ['github', 'https://user:pw@github.com/kim', 'credentials'],
        ['blog', 'https://127.0.0.1/', 'ip_literal'],
        ['blog', 'https://2130706433/', 'ip_literal'],
        ['blog', 'https://[::1]/', 'ip_literal'],
        ['blog', 'https://intranet.internal/', 'host'],
        ['blog', 'https://localhost/', 'host'],
        ['blog', 'https://blog.example.com:8443/', 'port'],
        ['github', 'https://evil.example.com/kim', 'provider_mismatch'],
        ['blog', `https://blog.example.com/${'x'.repeat(300)}`, 'too_long'],
        ['blog', 42, 'invalid'],
      ]
      for (const [provider, url, reason] of cases) {
        const e = await expectServiceError(addSocialLink(tx, A.actor, A.realId, { provider, url }, T0), 'VALIDATION')
        expect(e.fields, String(url)).toEqual({ url: reason })
      }
      expect((await expectServiceError(addSocialLink(tx, A.actor, A.realId, { provider: 'myspace', url: 'https://x.example.com' }, T0), 'VALIDATION')).fields).toEqual({
        provider: 'invalid',
      })
      // DB도 https가 아닌 주소를 받지 않습니다.
      await expect(tx.transaction((inner) => inner.insert(socialLinks).values({ personaId: A.realId, userId: A.user.id, provider: 'blog', url: 'http://x.example.com' }))).rejects.toThrow()
    })
  })

  it('ownership: other people get 404 on every write path and on the owner list', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '주인')
      const B = await person(tx, '남')
      const link = await addSocialLink(tx, A.actor, A.realId, { provider: 'blog', url: 'https://a.example.com/' }, T0)
      await expectServiceError(addSocialLink(tx, B.actor, A.realId, { provider: 'blog', url: 'https://b.example.com/' }, T0), 'NOT_FOUND')
      await expectServiceError(listMySocialLinks(tx, B.actor, A.realId, ORIGIN), 'NOT_FOUND')
      await expectServiceError(removeSocialLink(tx, B.actor, link.id), 'NOT_FOUND')
      await expectServiceError(requestSocialLinkVerification(tx, B.actor, link.id, T0), 'NOT_FOUND')
      await expectServiceError(removeSocialLink(tx, B.actor, 'not-a-uuid'), 'NOT_FOUND')
      await expectServiceError(listMySocialLinks(tx, A.actor, crypto.randomUUID(), ORIGIN), 'NOT_FOUND')
      expect((await listMySocialLinks(tx, A.actor, A.realId, ORIGIN)).links).toHaveLength(1)
      // DB: 사용자 사본 열을 남의 것으로 위조하면 복합 외래 키 위반.
      await expect(tx.transaction((inner) => inner.insert(socialLinks).values({ personaId: A.realId, userId: B.user.id, provider: 'blog', url: 'https://c.example.com/' }))).rejects.toThrow()
    })
  })

  it(`limit ${SOCIAL_LINK_LIMIT} per persona, duplicates, and one URL may belong to only one of my personas`, async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '한도', { display: true })
      for (let i = 0; i < SOCIAL_LINK_LIMIT; i++) await addSocialLink(tx, A.actor, A.realId, { provider: 'other', url: `https://site${i}.example.com/` }, T0)
      const e = await expectServiceError(addSocialLink(tx, A.actor, A.realId, { provider: 'other', url: 'https://one-more.example.com/' }, T0), 'CONFLICT', 'limit_reached')
      expect(e.details).toEqual({ limit: SOCIAL_LINK_LIMIT })
      // 표시명 프로필은 따로 셉니다.
      await addSocialLink(tx, A.actor, A.display!.id, { provider: 'blog', url: 'https://night.example.com/' }, T0)
      await expectServiceError(addSocialLink(tx, A.actor, A.display!.id, { provider: 'blog', url: 'https://night.example.com/#x' }, T0), 'CONFLICT', 'duplicate')
      // 실명 프로필에 있는 주소를 표시명 프로필에 걸면 두 프로필이 이어지므로 거부(반대도).
      await expectServiceError(addSocialLink(tx, A.actor, A.display!.id, { provider: 'other', url: 'https://site0.example.com/' }, T0), 'CONFLICT', 'used_by_other_persona')
      // 다른 사람은 같은 주소를 넣을 수 있습니다(되돌림 링크 확인은 각자의 프로필 주소로 함).
      const B = await person(tx, '다른')
      await addSocialLink(tx, B.actor, B.realId, { provider: 'other', url: 'https://site0.example.com/' }, T0)
    })
  })

  it('per-persona separation: a real persona’s links never appear on the display profile and vice versa, even with the identity link on', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '분리', { display: true })
      await addSocialLink(tx, A.actor, A.realId, { provider: 'github', url: 'https://github.com/real-kim' }, T0)
      await addSocialLink(tx, A.actor, A.display!.id, { provider: 'instagram', url: 'https://instagram.com/night_star' }, T0)
      for (const visible of [false, true]) {
        await setIdentityLink(tx, A.actor, { visible }, T0)
        const real = JSON.stringify(await getPublicPortfolioProfile(tx, A.realHandle, T0))
        const disp = JSON.stringify(await getPublicPortfolioProfile(tx, A.display!.handle, T0))
        expect(real).toContain('github.com/real-kim')
        expect(real, `visible=${visible}`).not.toContain('night_star')
        expect(disp).toContain('night_star')
        expect(disp, `visible=${visible}`).not.toContain('real-kim')
      }
      expect((await listMySocialLinks(tx, A.actor, A.display!.id, ORIGIN)).links.map((l) => l.url)).toEqual(['https://instagram.com/night_star'])
      expect((await listMySocialLinks(tx, A.actor, A.display!.id, ORIGIN)).backLinkUrl).toBe(`${ORIGIN}/u/${A.display!.handle}`)
    })
  })

  it('verify request: outbox social_link.verify with the link id only, pending until the worker writes a result; verified shows the badge publicly, lost does not', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '확인')
      const link = await addSocialLink(tx, A.actor, A.realId, { provider: 'github', url: 'https://github.com/verify-me' }, T0)
      const requested = await requestSocialLinkVerification(tx, A.actor, link.id, T0)
      expect(requested).toMatchObject({ verification: 'unverified', verifyPending: true })
      const events = await tx.select().from(outboxEvents).where(and(eq(outboxEvents.topic, SOCIAL_LINK_VERIFY_TOPIC), sql`${outboxEvents.payload}->>'socialLinkId' = ${link.id}`))
      expect(events.map((e) => e.payload)).toEqual([{ socialLinkId: link.id }])
      expect(JSON.stringify(events)).not.toContain('verify-me')

      // worker가 쓴 결과(여기서는 행을 직접): verified → 공개 배지.
      const later = new Date(T0.getTime() + 5000)
      await tx.update(socialLinks).set({ verification: 'verified', verifiedAt: later, lastCheckedAt: later, lastCheckResult: 'found' }).where(eq(socialLinks.id, link.id))
      expect((await listMySocialLinks(tx, A.actor, A.realId, ORIGIN)).links[0]).toMatchObject({ verification: 'verified', verifyPending: false, lastCheckResult: 'found' })
      expect(await publicSocialLinks(tx, A.realId)).toEqual([{ provider: 'github', url: 'https://github.com/verify-me', verified: true }])
      // lost: 공개에는 확인 표시만 빠지고 "끊김"·결과는 싣지 않습니다.
      await tx.update(socialLinks).set({ verification: 'lost', verifiedAt: null, lastCheckResult: 'missing' }).where(eq(socialLinks.id, link.id))
      const pub = await getPublicPortfolioProfile(tx, A.realHandle, T0)
      expect(pub.socialLinks).toEqual([{ provider: 'github', url: 'https://github.com/verify-me', verified: false }])
      expect(JSON.stringify(pub.socialLinks)).not.toMatch(/lost|missing|lastChecked/)
    })
  })

  it('verify requests are rate limited per link and per user; deactivated personas cannot request', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '한도')
      const link = await addSocialLink(tx, A.actor, A.realId, { provider: 'blog', url: 'https://rl.example.com/' }, T0)
      for (let i = 0; i < SOCIAL_LINK_VERIFY_LINK_RATE_LIMIT.limit; i++) await requestSocialLinkVerification(tx, A.actor, link.id, T0)
      await expectServiceError(requestSocialLinkVerification(tx, A.actor, link.id, T0), 'RATE_LIMITED')
      // 다음 시간 창에서는 다시 됩니다.
      await requestSocialLinkVerification(tx, A.actor, link.id, new Date(T0.getTime() + SOCIAL_LINK_VERIFY_LINK_RATE_LIMIT.windowMs))
      const other = await addSocialLink(tx, A.actor, A.realId, { provider: 'blog', url: 'https://rl2.example.com/' }, T0)
      await tx.update(personas).set({ status: 'deactivated' }).where(eq(personas.id, A.realId))
      await expectServiceError(requestSocialLinkVerification(tx, A.actor, other.id, T0), 'CONFLICT', 'persona_inactive')
    })
  })

  it('audit: add/remove/verify-request carry ids, kinds and flags only — never the URL', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '감사', { display: true })
      const link = await addSocialLink(tx, A.actor, A.display!.id, { provider: 'youtube', url: 'https://www.youtube.com/@secret-channel' }, T0)
      await requestSocialLinkVerification(tx, A.actor, link.id, T0)
      await removeSocialLink(tx, A.actor, link.id)
      const rows = await tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.actorId, A.user.id), inArray(auditEvents.action, ['social_link.add', 'social_link.verify_request', 'social_link.remove'])))
      expect(rows.map((r) => r.action).sort()).toEqual(['social_link.add', 'social_link.remove', 'social_link.verify_request'])
      for (const r of rows) {
        expect(r.targetType).toBe('social_link')
        expect(r.targetId).toBe(link.id)
        expect(Object.keys(r.metadata as object).every((k) => ['personaId', 'personaKind', 'provider', 'verification'].includes(k))).toBe(true)
        expect(r.metadata).toMatchObject({ personaId: A.display!.id, personaKind: 'display', provider: 'youtube' })
        expect(JSON.stringify(r)).not.toMatch(/secret-channel|youtube\.com|https?:/)
      }
    })
  })

  it('blocked viewers: the session endpoint 404s the hidden persona (links included); the public SSR path is the same as logged out', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '차단자', { display: true })
      const B = await person(tx, '차단됨')
      await addSocialLink(tx, A.actor, A.display!.id, { provider: 'blog', url: 'https://hidden.example.com/' }, T0)
      await createBlock(tx, A.actor, { handle: B.realHandle, as: A.display!.id }, T0)
      await expectServiceError(getProfileSocial(tx, B.actor, A.display!.handle), 'NOT_FOUND')
      // 공개 경로(쿠키 없음)는 판정할 수 없으므로 로그아웃한 방문자와 같은 응답입니다(ADR 0033).
      expect((await getPublicPortfolioProfile(tx, A.display!.handle, T0)).socialLinks).toEqual([{ provider: 'blog', url: 'https://hidden.example.com/', verified: false }])
    })
  })
})
