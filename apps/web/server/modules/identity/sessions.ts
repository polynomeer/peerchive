/**
 * DB 세션 (ADR 0006). Lucia 가이드의 방식을 따릅니다.
 *
 * - 쿠키 값: `<id>.<secret>`. id(144비트)는 조회 키, secret(256비트)은 SHA-256 해시만 저장하고
 *   timingSafeEqual로 비교합니다.
 * - 만료 30일, 남은 기간이 15일 미만이면 사용할 때 30일로 연장(sliding)합니다.
 * - 사용자 status가 active가 아니면 세션을 지우고 거부합니다(정지·탈퇴 즉시 반영).
 */
import { eq, sessions, users, type DbExecutor } from '@peerchive/db'
import { constantTimeEqualHex, generateToken, looksLikeToken, sha256Hex } from '../security/tokens'

const DAY_MS = 24 * 60 * 60 * 1000
export const SESSION_TTL_MS = 30 * DAY_MS
export const SESSION_RENEW_THRESHOLD_MS = 15 * DAY_MS
export const SESSION_COOKIE_NAME = 'peerchive_session'

export interface CreatedSession {
  /** 쿠키에 넣을 원문 토큰. 저장·로그 금지. */
  token: string
  sessionId: string
  expiresAt: Date
}

export interface SessionUser {
  id: string
  displayName: string
  status: 'active' | 'suspended' | 'deleted'
}

export interface ValidatedSession {
  sessionId: string
  user: SessionUser
  expiresAt: Date
  /** sliding 연장이 일어났으면 true(쿠키 만료도 갱신해야 함). */
  renewed: boolean
}

export async function createSession(db: DbExecutor, userId: string, now = new Date()): Promise<CreatedSession> {
  const sessionId = generateToken(18)
  const secret = generateToken(32)
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  await db.insert(sessions).values({ id: sessionId, secretHash: sha256Hex(secret), userId, expiresAt, createdAt: now })
  return { token: `${sessionId}.${secret}`, sessionId, expiresAt }
}

function splitToken(token: string): { id: string; secret: string } | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [id, secret] = parts as [string, string]
  if (!looksLikeToken(id, 64) || !looksLikeToken(secret, 64)) return null
  return { id, secret }
}

export async function validateSessionToken(
  db: DbExecutor,
  token: string | undefined | null,
  now = new Date(),
): Promise<ValidatedSession | null> {
  if (!token) return null
  const parsed = splitToken(token)
  if (!parsed) return null

  const [row] = await db
    .select({
      id: sessions.id,
      secretHash: sessions.secretHash,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      displayName: users.displayName,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, parsed.id))
    .limit(1)
  if (!row) return null
  if (!constantTimeEqualHex(sha256Hex(parsed.secret), row.secretHash)) return null

  if (row.expiresAt.getTime() <= now.getTime() || row.status !== 'active') {
    await db.delete(sessions).where(eq(sessions.id, row.id))
    return null
  }

  let expiresAt = row.expiresAt
  let renewed = false
  if (expiresAt.getTime() - now.getTime() < SESSION_RENEW_THRESHOLD_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, row.id))
    renewed = true
  }

  return {
    sessionId: row.id,
    user: { id: row.userId, displayName: row.displayName, status: row.status },
    expiresAt,
    renewed,
  }
}

export async function invalidateSession(db: DbExecutor, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

export async function invalidateUserSessions(db: DbExecutor, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}
