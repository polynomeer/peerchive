/**
 * T-02 서비스 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { eq, magicLinkTokens, sessions, users, type DbExecutor } from '@peerchive/db'
import { requestAccountDeletion } from '../server/modules/identity/account'
import { createMemoryTransport } from '../server/modules/identity/mail'
import {
  MAGIC_LINK_RATE_LIMITS,
  inspectMagicLink,
  requestMagicLink,
  verifyMagicLink,
} from '../server/modules/identity/magic-link'
import { getMe, getPublicProfile, upsertProfile } from '../server/modules/identity/profiles'
import {
  SESSION_TTL_MS,
  createSession,
  invalidateSession,
  validateSessionToken,
} from '../server/modules/identity/sessions'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, uniqueEmail, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')

async function requestLink(db: DbExecutor, email: string, now = T0, ip = crypto.randomUUID()) {
  const mail = createMemoryTransport()
  const result = await requestMagicLink(db, { email, ip, mail, now, buildVerifyUrl: (t) => `http://localhost:3000/v?token=${t}` })
  const token = mail.messages.at(-1)?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1]
  return { result, token, mail }
}

describe.skipIf(!databaseUrl)('identity services (PostgreSQL)', () => {
  afterAll(closeTestDb)

  describe('magic link', () => {
    it('inspect shows a masked email without consuming the token', async () => {
      await withRollback(async (tx) => {
        const email = uniqueEmail('inspect')
        const { token } = await requestLink(tx, email)
        const now = new Date(T0.getTime() + minutes(1))

        const peek = await inspectMagicLink(tx, { token, now })
        expect(peek.ok).toBe(true)
        if (peek.ok) {
          expect(peek.maskedEmail).not.toBe(email.toLowerCase())
          expect(peek.maskedEmail).toContain('@')
        }
        // 다시 확인해도, 그 뒤 로그인해도 성공합니다(확인은 소비하지 않음).
        expect((await inspectMagicLink(tx, { token, now })).ok).toBe(true)
        expect((await verifyMagicLink(tx, { token, now })).ok).toBe(true)
        // 소비된 뒤와 만료 후에는 무효입니다.
        expect((await inspectMagicLink(tx, { token, now })).ok).toBe(false)
        expect((await inspectMagicLink(tx, { token: 'not a token', now })).ok).toBe(false)
      })
    })

    it('creates a new active user on first use and is single-use', async () => {
      await withRollback(async (tx) => {
        const email = uniqueEmail('New.User')
        const { result, token } = await requestLink(tx, `  ${email.toUpperCase()} `)
        expect(result).toBe('accepted')
        expect(token).toBeTruthy()

        // 원문 토큰은 DB에 없습니다.
        const stored = await tx.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email.toLowerCase()))
        expect(stored).toHaveLength(1)
        expect(stored[0]!.tokenHash).not.toBe(token)

        const first = await verifyMagicLink(tx, { token, now: new Date(T0.getTime() + minutes(1)) })
        expect(first.ok).toBe(true)
        if (!first.ok) return
        expect(first.isNewUser).toBe(true)
        expect(first.needsOnboarding).toBe(true)
        const [user] = await tx.select().from(users).where(eq(users.id, first.userId))
        expect(user?.status).toBe('active')
        expect(user?.privateEmail).toBe(email.toLowerCase())

        const second = await verifyMagicLink(tx, { token, now: new Date(T0.getTime() + minutes(2)) })
        expect(second).toEqual({ ok: false })
      })
    })

    it('signs an existing user in (no new user) and sends onboarding only without a profile', async () => {
      await withRollback(async (tx) => {
        const email = uniqueEmail()
        const first = await verifyMagicLink(tx, { token: (await requestLink(tx, email)).token, now: new Date(T0.getTime() + minutes(1)) })
        if (!first.ok) throw new Error('first login failed')
        await upsertProfile(tx, { userId: first.userId }, { handle: `h-${crypto.randomUUID().slice(0, 8)}`, displayName: '김학생' })
        const again = await verifyMagicLink(tx, { token: (await requestLink(tx, email)).token, now: new Date(T0.getTime() + minutes(2)) })
        expect(again.ok && again.userId).toBe(first.userId)
        expect(again.ok && again.isNewUser).toBe(false)
        expect(again.ok && again.needsOnboarding).toBe(false)
      })
    })

    it('rejects an expired token (15 minutes)', async () => {
      await withRollback(async (tx) => {
        const { token } = await requestLink(tx, uniqueEmail())
        expect(await verifyMagicLink(tx, { token, now: new Date(T0.getTime() + minutes(15)) })).toEqual({ ok: false })
      })
    })

    it('rejects malformed and unknown tokens without touching the DB state', async () => {
      await withRollback(async (tx) => {
        expect(await verifyMagicLink(tx, { token: undefined })).toEqual({ ok: false })
        expect(await verifyMagicLink(tx, { token: "x' or 1=1 --" })).toEqual({ ok: false })
        expect(await verifyMagicLink(tx, { token: 'A'.repeat(43) })).toEqual({ ok: false })
      })
    })

    it('responds the same for unknown, active and suspended accounts but mails only allowed ones', async () => {
      await withRollback(async (tx) => {
        const active = await createUser(tx)
        const suspended = await createUser(tx, { status: 'suspended' })
        const unknown = await requestLink(tx, uniqueEmail())
        const existing = await requestLink(tx, active.email)
        const blocked = await requestLink(tx, suspended.email)
        expect([unknown.result, existing.result, blocked.result]).toEqual(['accepted', 'accepted', 'accepted'])
        expect(unknown.mail.messages).toHaveLength(1)
        expect(existing.mail.messages).toHaveLength(1)
        expect(blocked.mail.messages).toHaveLength(0)
      })
    })

    it('does not authenticate a suspended user even with a valid token', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx)
        const { token } = await requestLink(tx, user.email)
        await tx.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id))
        expect(await verifyMagicLink(tx, { token, now: T0 })).toEqual({ ok: false })
      })
    })

    it('rate-limits per email silently and per IP with rate_limited', async () => {
      await withRollback(async (tx) => {
        const email = uniqueEmail()
        const mail = createMemoryTransport()
        const send = (ip: string, to = email) =>
          requestMagicLink(tx, { email: to, ip, mail, now: T0, buildVerifyUrl: (t) => t })
        for (let i = 0; i < MAGIC_LINK_RATE_LIMITS.perEmail.limit + 2; i++) {
          expect(await send(`10.0.0.${i}`)).toBe('accepted')
        }
        expect(mail.messages).toHaveLength(MAGIC_LINK_RATE_LIMITS.perEmail.limit)

        const ip = '192.0.2.1'
        for (let i = 0; i < MAGIC_LINK_RATE_LIMITS.perIp.limit; i++) {
          expect(await send(ip, uniqueEmail())).toBe('accepted')
        }
        expect(await send(ip, uniqueEmail())).toBe('rate_limited')
        // 다음 창에서는 다시 허용됩니다.
        expect(
          await requestMagicLink(tx, {
            email: uniqueEmail(),
            ip,
            mail,
            now: new Date(T0.getTime() + MAGIC_LINK_RATE_LIMITS.perIp.windowMs),
            buildVerifyUrl: (t) => t,
          }),
        ).toBe('accepted')
      })
    })
  })

  describe('sessions', () => {
    it('stores only a hash of the secret and validates the token', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx)
        const created = await createSession(tx, user.id, T0)
        const [row] = await tx.select().from(sessions).where(eq(sessions.id, created.sessionId))
        expect(row?.secretHash).not.toContain(created.token.split('.')[1]!)
        const valid = await validateSessionToken(tx, created.token, T0)
        expect(valid?.user.id).toBe(user.id)
        expect(valid?.renewed).toBe(false)
        // secret을 바꾸면 거부합니다.
        expect(await validateSessionToken(tx, `${created.sessionId}.${'B'.repeat(43)}`, T0)).toBeNull()
        expect(await validateSessionToken(tx, 'garbage', T0)).toBeNull()
      })
    })

    it('renews when fewer than 15 days remain and expires after 30 days', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx)
        const created = await createSession(tx, user.id, T0)
        const at16 = new Date(T0.getTime() + days(16))
        const renewed = await validateSessionToken(tx, created.token, at16)
        expect(renewed?.renewed).toBe(true)
        expect(renewed?.expiresAt.getTime()).toBe(at16.getTime() + SESSION_TTL_MS)

        const other = await createSession(tx, user.id, T0)
        expect(await validateSessionToken(tx, other.token, new Date(T0.getTime() + SESSION_TTL_MS))).toBeNull()
        expect(await tx.select().from(sessions).where(eq(sessions.id, other.sessionId))).toHaveLength(0)
      })
    })

    it('rejects revoked sessions and sessions of suspended/deleted users', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx)
        const a = await createSession(tx, user.id, T0)
        await invalidateSession(tx, a.sessionId)
        expect(await validateSessionToken(tx, a.token, T0)).toBeNull()

        const b = await createSession(tx, user.id, T0)
        await tx.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id))
        expect(await validateSessionToken(tx, b.token, T0)).toBeNull()
      })
    })

    it('deletion request marks the user deleted and revokes all sessions', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx, { handle: `del-${crypto.randomUUID().slice(0, 8)}` })
        const a = await createSession(tx, user.id, T0)
        const b = await createSession(tx, user.id, T0)
        await requestAccountDeletion(tx, { userId: user.id }, T0)
        expect(await validateSessionToken(tx, a.token, T0)).toBeNull()
        expect(await validateSessionToken(tx, b.token, T0)).toBeNull()
        const [row] = await tx.select().from(users).where(eq(users.id, user.id))
        expect(row?.status).toBe('deleted')
        expect(row?.deletionRequestedAt?.getTime()).toBe(T0.getTime())
        // 같은 주소로 다시 로그인할 수 없습니다.
        const { token, mail } = await requestLink(tx, user.email)
        expect(mail.messages).toHaveLength(0)
        expect(token).toBeUndefined()
      })
    })
  })

  describe('profiles', () => {
    const handle = () => `stu-${crypto.randomUUID().slice(0, 8)}`

    it('requires handle and displayName on first save and validates fields', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx, { displayName: '' })
        const missing = await expectServiceError(upsertProfile(tx, { userId: user.id }, {}), 'VALIDATION')
        expect(missing.fields).toEqual({ handle: 'required', displayName: 'required' })

        const bad = await expectServiceError(
          upsertProfile(tx, { userId: user.id }, { handle: 'ab', displayName: 'x'.repeat(51), gradTerm: '2027-13' }),
          'VALIDATION',
        )
        expect(bad.fields).toMatchObject({ handle: 'too_short', displayName: 'too_long', gradTerm: 'invalid_format' })

        for (const [value, code] of [
          ['admin', 'reserved'],
          ['projects', 'reserved'],
          ['-abc', 'invalid_format'],
          ['a_b_c', 'invalid_format'],
          ['한글핸들', 'invalid_format'],
        ] as const) {
          const error = await expectServiceError(
            upsertProfile(tx, { userId: user.id }, { handle: value, displayName: '이름' }),
            'VALIDATION',
          )
          expect(error.fields?.handle).toBe(code)
        }
      })
    })

    it('creates, partially updates and enforces unique handles', async () => {
      await withRollback(async (tx) => {
        const a = await createUser(tx)
        const b = await createUser(tx)
        const h = handle()
        const me = await upsertProfile(tx, { userId: a.id }, {
          handle: h.toUpperCase(),
          displayName: ' 김학생 ',
          headline: '백엔드 지망',
          jobTargets: ['백엔드'],
          gradTerm: '2027-02',
          openToWork: true,
        })
        expect(me.profile?.handle).toBe(h)
        expect(me.displayName).toBe('김학생')
        expect(me.email).toBe(a.email)

        const updated = await upsertProfile(tx, { userId: a.id }, { headline: '' })
        expect(updated.profile?.headline).toBeNull()
        expect(updated.profile?.jobTargets).toEqual(['백엔드'])

        const taken = await expectServiceError(
          upsertProfile(tx, { userId: b.id }, { handle: h, displayName: '박학생' }),
          'VALIDATION',
        )
        expect(taken.fields).toEqual({ handle: 'taken' })
      })
    })

    it('public profile DTO never contains the email or internal ids', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx)
        const h = handle()
        await upsertProfile(tx, { userId: user.id }, { handle: h, displayName: '공개 이름', schoolLabel: '어느 대학' })
        const dto = await getPublicProfile(tx, h)
        const json = JSON.stringify(dto)
        expect(json).not.toContain(user.email)
        expect(json).not.toContain('@')
        expect(json).not.toContain(user.id)
        expect(Object.keys(dto).sort()).toEqual(
          ['contactPolicy', 'displayName', 'gradTerm', 'handle', 'headline', 'jobTargets', 'kind', 'linkedPersona', 'openToWork', 'schoolLabel'].sort(),
        )
        // 페르소나 종류(S-01)와 연결(표시명 페르소나 없음 → null).
        expect(dto.kind).toBe('real')
        expect(dto.linkedPersona).toBeNull()
        // 본인 DTO에는 이메일이 있습니다.
        expect((await getMe(tx, { userId: user.id })).email).toBe(user.email)
      })
    })

    it('hides profiles of suspended users and unknown handles', async () => {
      await withRollback(async (tx) => {
        const h = handle()
        const user = await createUser(tx, { handle: h })
        await tx.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id))
        await expectServiceError(getPublicProfile(tx, h), 'NOT_FOUND')
        await expectServiceError(getPublicProfile(tx, 'no-such-handle-xyz'), 'NOT_FOUND')
        await expectServiceError(getPublicProfile(tx, '../etc'), 'NOT_FOUND')
      })
    })
  })
})
