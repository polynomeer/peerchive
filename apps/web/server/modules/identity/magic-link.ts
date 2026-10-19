/**
 * 이메일 매직링크 로그인 (ADR 0006).
 *
 * - 요청: 계정 유무·상태와 관계없이 같은 응답(202)을 돌려줍니다(계정 열거 방지).
 *   IP별 한도를 넘으면 429, 이메일별 한도를 넘으면 조용히 발송만 건너뜁니다.
 * - 토큰: 256비트, SHA-256 해시만 저장, 15분 만료, 한 번만 사용(UPDATE ... WHERE used_at IS NULL).
 * - 검증: 처음 보는 이메일이면 사용자(active)와 email 로그인 계정을 만들고 세션을 발급합니다.
 */
import {
  and,
  eq,
  gt,
  isNull,
  sql,
  authAccounts,
  magicLinkTokens,
  profiles,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { generateToken, looksLikeToken, sha256Hex } from '../security/tokens'
import { hitRateLimit, type RateLimitRule } from '../security/rate-limit'
import { maskEmail, type MailTransport } from './mail'
import { createSession, type CreatedSession } from './sessions'

const MINUTE_MS = 60 * 1000
export const MAGIC_LINK_TTL_MS = 15 * MINUTE_MS

/** 초기 한도. 운영 지표를 보고 조정합니다. */
export const MAGIC_LINK_RATE_LIMITS = {
  perEmail: { limit: 5, windowMs: 15 * MINUTE_MS },
  perIp: { limit: 20, windowMs: 15 * MINUTE_MS },
} satisfies Record<string, RateLimitRule>

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface MagicLinkRequest {
  email: string
  /** 요청 IP. 알 수 없으면 'unknown'(모두 같은 버킷)으로 넘깁니다. */
  ip: string
  mail: MailTransport
  /** 원문 토큰으로 검증 URL을 만듭니다. */
  buildVerifyUrl: (token: string) => string
  now?: Date
}

export type MagicLinkRequestResult = 'accepted' | 'rate_limited'

export async function requestMagicLink(db: DbExecutor, input: MagicLinkRequest): Promise<MagicLinkRequestResult> {
  const now = input.now ?? new Date()
  const email = normalizeEmail(input.email)

  if (!(await hitRateLimit(db, 'magic_link_ip', input.ip, MAGIC_LINK_RATE_LIMITS.perIp, now))) return 'rate_limited'
  // 이메일별 한도 초과는 응답을 바꾸지 않습니다(같은 202).
  if (!(await hitRateLimit(db, 'magic_link_email', email, MAGIC_LINK_RATE_LIMITS.perEmail, now))) return 'accepted'

  // 정지·탈퇴 계정에는 보내지 않지만 응답은 같습니다.
  const [existing] = await db
    .select({ status: users.status })
    .from(users)
    .where(sql`lower(${users.privateEmail}) = ${email}`)
    .limit(1)
  if (existing && existing.status !== 'active') return 'accepted'

  const token = generateToken()
  await db.insert(magicLinkTokens).values({
    email,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
    createdAt: now,
  })

  await input.mail.send({
    to: email,
    subject: 'Peerchive 로그인 링크',
    text: [
      '아래 링크를 열면 Peerchive에 로그인합니다. 링크는 15분 동안 한 번만 쓸 수 있습니다.',
      '',
      input.buildVerifyUrl(token),
      '',
      '직접 요청하지 않았다면 이 메일을 무시하세요.',
    ].join('\n'),
  })
  return 'accepted'
}

/**
 * 토큰을 소비하지 않고 유효 여부와 가린 이메일만 확인합니다("로그인 확인" 페이지용).
 * 링크를 연 사람에게 어느 계정으로 로그인하는지 보여 주어, 남이 보낸 링크로 남의 계정에
 * 로그인되는 login CSRF를 알아차리게 합니다. 링크는 원래 그 주소로 발송된 것이므로
 * 가린 주소를 보여 주는 것은 새로운 노출이 아닙니다.
 */
export async function inspectMagicLink(
  db: DbExecutor,
  input: { token: unknown; now?: Date },
): Promise<{ ok: true; maskedEmail: string } | { ok: false }> {
  const now = input.now ?? new Date()
  if (!looksLikeToken(input.token)) return { ok: false }
  const [row] = await db
    .select({ email: magicLinkTokens.email })
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.tokenHash, sha256Hex(input.token)),
        isNull(magicLinkTokens.usedAt),
        gt(magicLinkTokens.expiresAt, now),
      ),
    )
    .limit(1)
  return row ? { ok: true, maskedEmail: maskEmail(row.email) } : { ok: false }
}

export type MagicLinkVerifyResult =
  | { ok: true; userId: string; isNewUser: boolean; needsOnboarding: boolean; session: CreatedSession }
  | { ok: false }

/**
 * 토큰을 소비하고 세션을 만듭니다. 실패 이유(만료·사용됨·없음·계정 정지)는 구분해 돌려주지 않습니다.
 */
export async function verifyMagicLink(
  db: DbExecutor,
  input: { token: unknown; now?: Date },
): Promise<MagicLinkVerifyResult> {
  const now = input.now ?? new Date()
  if (!looksLikeToken(input.token)) return { ok: false }
  const tokenHash = sha256Hex(input.token)

  return db.transaction(async (tx) => {
    // 조건부 UPDATE로 소비해 동시 요청에서도 한 번만 성공합니다.
    const [consumed] = await tx
      .update(magicLinkTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(magicLinkTokens.tokenHash, tokenHash),
          isNull(magicLinkTokens.usedAt),
          gt(magicLinkTokens.expiresAt, now),
        ),
      )
      .returning({ email: magicLinkTokens.email })
    if (!consumed) return { ok: false } as const

    const email = consumed.email
    let isNewUser = false

    const [account] = await tx
      .select({ userId: users.id, status: users.status })
      .from(authAccounts)
      .innerJoin(users, eq(users.id, authAccounts.userId))
      .where(and(eq(authAccounts.provider, 'email'), eq(authAccounts.providerAccountId, email)))
      .limit(1)

    let user = account ? { id: account.userId, status: account.status } : undefined
    if (!user) {
      // 다른 경로로 만들어진 같은 주소의 사용자가 있으면 연결하고, 없으면 새로 만듭니다.
      const [byEmail] = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(sql`lower(${users.privateEmail}) = ${email}`)
        .limit(1)
      if (byEmail) {
        user = byEmail
      } else {
        // display_name은 온보딩에서 받습니다. 이메일 일부를 이름으로 쓰지 않습니다(공개 노출 방지).
        const [created] = await tx
          .insert(users)
          .values({ displayName: '', privateEmail: email, status: 'active' })
          .returning({ id: users.id, status: users.status })
        if (!created) throw new Error('user insert failed')
        user = created
        isNewUser = true
      }
      await tx.insert(authAccounts).values({ userId: user.id, provider: 'email', providerAccountId: email })
    }

    if (user.status !== 'active') return { ok: false } as const

    const [profile] = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.userId, user.id))
      .limit(1)
    const session = await createSession(tx, user.id, now)
    return { ok: true, userId: user.id, isNewUser, needsOnboarding: !profile, session } as const
  })
}
