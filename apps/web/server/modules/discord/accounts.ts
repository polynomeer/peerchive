/**
 * 디스코드 계정 연결 (T-09, SYSTEM_DESIGN §6.1 Integration·§12.1, ADR 0009).
 *
 * - 웹: 로그인한 사용자가 연결 코드(10분·한 번만)를 만들고, 연결 상태를 보고, 해제합니다.
 * - 봇(내부 API): `/peerchive link <코드>`를 실행한 디스코드 사용자 id를 코드 주인 계정에 연결합니다.
 *   한 디스코드 계정은 한 Peerchive 계정에만, 한 Peerchive 계정은 디스코드 계정 하나에만 연결됩니다.
 *   이미 다른 계정에 연결된 디스코드 계정이면 `discord_account_in_use`(코드는 쓰지 않음), 이 계정에 다른 디스코드가
 *   연결돼 있으면 그것을 해제하고 바꿉니다(`relinked`).
 * - 디스코드 토큰은 받지 않습니다(봇 토큰 하나로 동작). 저장하는 것은 디스코드 사용자 id뿐입니다.
 */
import { z } from 'zod'
import { and, eq, integrations, isNull, users, type DbExecutor } from '@peerchive/db'
import type { LinkResponse } from '@peerchive/bot-protocol'
import { recordAudit } from '../audit/audit'
import { type Actor, sqlState } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { CODE_RATE_LIMIT, consumeCode, findUsableCode, insertCode } from './codes'
import type { DiscordCodeDto, IntegrationsDto } from '../../../shared/types/api'

/** 디스코드 snowflake(숫자 문자열). */
export const snowflake = z.string({ error: 'required' }).regex(/^\d{5,25}$/, { error: 'invalid' })

export type IntegrationRow = typeof integrations.$inferSelect

/** 연결 중인 디스코드 계정(디스코드 id로). 계정이 active가 아니면 없는 것으로 봅니다. */
export async function findDiscordIntegration(db: DbExecutor, discordUserId: string): Promise<IntegrationRow | null> {
  const [row] = await db
    .select({ integration: integrations })
    .from(integrations)
    .innerJoin(users, eq(users.id, integrations.userId))
    .where(
      and(
        eq(integrations.provider, 'discord'),
        eq(integrations.externalId, discordUserId),
        isNull(integrations.revokedAt),
        eq(users.status, 'active'),
      ),
    )
    .limit(1)
  return row?.integration ?? null
}

async function findUserIntegration(db: DbExecutor, userId: string): Promise<IntegrationRow | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, 'discord'), isNull(integrations.revokedAt)))
    .limit(1)
  return row ?? null
}

// ── 웹 ──

export async function getIntegrations(db: DbExecutor, actor: Actor): Promise<IntegrationsDto> {
  const row = await findUserIntegration(db, actor.userId)
  return {
    discord: {
      linked: !!row,
      linkedAt: row?.linkedAt.toISOString() ?? null,
      externalIdHint: row ? `…${row.externalId.slice(-4)}` : null,
    },
  }
}

export async function createLinkCode(db: DbExecutor, actor: Actor, now = new Date()): Promise<DiscordCodeDto> {
  const { code, expiresAt } = await insertCode(db, 'link', actor.userId, null, now)
  return { code, expiresAt: expiresAt.toISOString() }
}

/** 연결 해제(없어도 성공). 이미 만든 로그·채널 연결은 그대로 둡니다. */
export async function unlinkDiscord(db: DbExecutor, actor: Actor, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(integrations)
      .set({ revokedAt: now })
      .where(and(eq(integrations.userId, actor.userId), eq(integrations.provider, 'discord'), isNull(integrations.revokedAt)))
      .returning({ id: integrations.id })
    for (const row of rows) {
      await recordAudit(tx, { actorId: actor.userId, action: 'integration.unlink', targetType: 'integration', targetId: row.id })
    }
  })
}

// ── 봇(내부 API) ──

const linkSchema = z.object({ discordUserId: snowflake, code: z.string({ error: 'required' }).max(40, { error: 'invalid' }) })

export async function linkDiscordAccount(db: DbExecutor, rawInput: unknown, now = new Date()): Promise<LinkResponse> {
  const input = parseInput(linkSchema, rawInput)
  if (!(await hitRateLimit(db, 'discord-code', input.discordUserId, CODE_RATE_LIMIT, now))) return { status: 'rate_limited' }
  try {
    return await db.transaction(async (tx): Promise<LinkResponse> => {
      const code = await findUsableCode(tx, 'link', input.code, now)
      if (!code) return { status: 'invalid_code' }
      const [owner] = await tx.select({ status: users.status }).from(users).where(eq(users.id, code.userId)).limit(1)
      if (owner?.status !== 'active') return { status: 'invalid_code' }

      const linkedDiscord = await findDiscordIntegration(tx, input.discordUserId)
      if (linkedDiscord && linkedDiscord.userId !== code.userId) return { status: 'discord_account_in_use' }
      if (linkedDiscord) {
        await consumeCode(tx, code.id, now)
        return { status: 'already_linked' }
      }
      const previous = await findUserIntegration(tx, code.userId)
      if (previous) await tx.update(integrations).set({ revokedAt: now }).where(eq(integrations.id, previous.id))
      if (!(await consumeCode(tx, code.id, now))) return { status: 'invalid_code' }
      const [row] = await tx
        .insert(integrations)
        .values({ userId: code.userId, provider: 'discord', externalId: input.discordUserId, linkedAt: now })
        .returning({ id: integrations.id })
      await recordAudit(tx, {
        actorId: code.userId,
        action: 'integration.link',
        targetType: 'integration',
        targetId: row?.id ?? null,
        metadata: { provider: 'discord', relinked: !!previous },
      })
      return { status: previous ? 'relinked' : 'linked' }
    })
  } catch (error) {
    // 같은 디스코드 계정을 동시에 다른 계정으로 연결하면 unique 인덱스가 한쪽을 막습니다.
    if (sqlState(error) === '23505') return { status: 'discord_account_in_use' }
    throw error
  }
}
