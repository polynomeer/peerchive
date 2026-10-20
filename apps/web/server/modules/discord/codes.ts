/**
 * 디스코드 일회용 코드(계정 연결·채널 연결, ADR 0009).
 *
 * - 10자, 헷갈리는 글자(I·O·0·1)를 뺀 32자 알파벳에서 CSPRNG로 뽑습니다(50비트). 10분 만료, 한 번만.
 * - DB에는 `sha256(kind:code)`만 저장합니다. 원문은 만든 응답에서 한 번만 보여 줍니다.
 * - 입력은 대소문자·공백·하이픈을 무시합니다(디스코드에서 옮겨 적기 쉽게).
 * - 무차별 대입은 내부 API(봇 서명 필요)와 디스코드 사용자별 rate limit(10분 10회)으로 막습니다.
 */
import { randomBytes } from 'node:crypto'
import { and, discordCodes, eq, gt, isNull, type DbExecutor } from '@peerchive/db'
import { sha256Hex } from '../security/tokens'

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 10
export const CODE_TTL_MS = 10 * 60 * 1000
export const CODE_RATE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

export type DiscordCodeKind = 'link' | 'bind'

export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  // 알파벳이 32자라 하위 5비트만 쓰면 치우침이 없습니다.
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31]
  return code
}

/** 입력 정규화. 형식이 맞지 않으면 null(DB를 조회하지 않음). */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== CODE_LENGTH) return null
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null
  return code
}

export const hashCode = (kind: DiscordCodeKind, code: string) => sha256Hex(`${kind}:${code}`)

export async function insertCode(
  db: DbExecutor,
  kind: DiscordCodeKind,
  userId: string,
  projectId: string | null,
  now: Date,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS)
  await db.insert(discordCodes).values({ kind, codeHash: hashCode(kind, code), userId, projectId, expiresAt, createdAt: now })
  return { code, expiresAt }
}

export type CodeRow = typeof discordCodes.$inferSelect

/** 쓸 수 있는(만료·사용 전) 코드 행. 없으면 null. */
export async function findUsableCode(db: DbExecutor, kind: DiscordCodeKind, rawCode: unknown, now: Date): Promise<CodeRow | null> {
  const code = normalizeCode(rawCode)
  if (!code) return null
  const [row] = await db
    .select()
    .from(discordCodes)
    .where(
      and(
        eq(discordCodes.codeHash, hashCode(kind, code)),
        eq(discordCodes.kind, kind),
        isNull(discordCodes.usedAt),
        gt(discordCodes.expiresAt, now),
      ),
    )
    .limit(1)
    .for('update')
  return row ?? null
}

/** 코드를 씁니다. 그 사이 다른 요청이 먼저 썼으면 false. */
export async function consumeCode(db: DbExecutor, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(discordCodes)
    .set({ usedAt: now })
    .where(and(eq(discordCodes.id, id), isNull(discordCodes.usedAt), gt(discordCodes.expiresAt, now)))
    .returning({ id: discordCodes.id })
  return rows.length === 1
}
