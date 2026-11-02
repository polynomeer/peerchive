/**
 * 디스코드 채널 ↔ 프로젝트 연결 (T-09, SYSTEM_DESIGN §12.1, ADR 0009).
 *
 * - owner가 웹에서 채널 연결 코드(10분·한 번만)를 만들고, 디스코드 채널에서 `/peerchive bind <코드>`로 연결합니다.
 *   실행한 디스코드 사용자는 코드를 만든 owner 계정에 연결돼 있어야 하고, 그 사람이 지금도 그 프로젝트 owner여야 합니다.
 * - 한 채널은 한 프로젝트에만 연결됩니다(다른 프로젝트가 이미 쓰면 `channel_taken`). 서버(guild)·채널 id만 저장합니다.
 * - 목록은 프로젝트 멤버가 보고, 주간 요약 켜기·해제는 owner만(아니면 403). 읽을 수 없는 프로젝트·연결은 404.
 * - 해제하면 그 채널의 승인 대기 📌 요청을 만료 처리하고 저장했던 메시지 내용을 지웁니다.
 *   AI 회의 채널 제안·동의·승인 전 회의 요약 초안(E-13, ADR 0058)도 함께 지웁니다.
 */
import { z } from 'zod'
import type { Membership } from '@peerchive/domain'
import {
  and,
  asc,
  discordChannelBindings,
  discordPinRequests,
  eq,
  isNull,
  projects,
  type DbExecutor,
} from '@peerchive/db'
import type { BindResponse } from '@peerchive/bot-protocol'
import { deleteMeetingChannelRows } from '../ai/meeting-channels'
import { recordAudit } from '../audit/audit'
import { type Actor, forbidden, notFound, sqlState } from '../errors'
import { findMembership, isUuid, loadReadableProject } from '../projects/access'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { findDiscordIntegration, snowflake } from './accounts'
import { CODE_RATE_LIMIT, consumeCode, findUsableCode, insertCode } from './codes'
import type { DiscordBindingDto, DiscordCodeDto } from '../../../shared/types/api'

export type BindingRow = typeof discordChannelBindings.$inferSelect

const isOwner = (membership: Membership | null) => membership?.status === 'active' && membership.role === 'owner'

function toBindingDto(row: BindingRow): DiscordBindingDto {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    label: row.label,
    summaryEnabled: row.summaryEnabled,
    createdAt: row.createdAt.toISOString(),
  }
}

/** 채널의 현재 연결(해제 전). guildId를 주면 그 서버의 채널인지도 확인합니다. */
export async function findActiveBinding(db: DbExecutor, channelId: string, guildId?: string): Promise<BindingRow | null> {
  const [row] = await db
    .select()
    .from(discordChannelBindings)
    .where(and(eq(discordChannelBindings.channelId, channelId), isNull(discordChannelBindings.unboundAt)))
    .limit(1)
  if (!row || (guildId !== undefined && row.guildId !== guildId)) return null
  return row
}

// ── 웹 ──

export async function createBindCode(db: DbExecutor, actor: Actor, projectId: unknown, now = new Date()): Promise<DiscordCodeDto> {
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  if (!isOwner(membership)) throw forbidden()
  const { code, expiresAt } = await insertCode(db, 'bind', actor.userId, project.id, now)
  return { code, expiresAt: expiresAt.toISOString() }
}

export async function listBindings(db: DbExecutor, actor: Actor, projectId: unknown): Promise<DiscordBindingDto[]> {
  const { project } = await loadReadableProject(db, actor, projectId)
  const rows = await db
    .select()
    .from(discordChannelBindings)
    .where(and(eq(discordChannelBindings.projectId, project.id), isNull(discordChannelBindings.unboundAt)))
    .orderBy(asc(discordChannelBindings.createdAt), asc(discordChannelBindings.id))
  return rows.map(toBindingDto)
}

/** 연결과 그 프로젝트 접근 컨텍스트. 없거나 해제됐거나 읽을 수 없으면 404, owner가 아니면 403. */
async function loadOwnedBinding(db: DbExecutor, actor: Actor, bindingId: unknown) {
  if (!isUuid(bindingId)) throw notFound()
  const [binding] = await db
    .select()
    .from(discordChannelBindings)
    .where(and(eq(discordChannelBindings.id, bindingId), isNull(discordChannelBindings.unboundAt)))
    .limit(1)
    .for('update')
  if (!binding) throw notFound()
  const { membership } = await loadReadableProject(db, actor, binding.projectId)
  if (!isOwner(membership)) throw forbidden()
  return binding
}

const updateBindingSchema = z.object({ summaryEnabled: z.boolean({ error: 'required' }) })

export async function updateBinding(
  db: DbExecutor,
  actor: Actor,
  bindingId: unknown,
  rawInput: unknown,
): Promise<DiscordBindingDto> {
  const input = parseInput(updateBindingSchema, rawInput)
  return db.transaction(async (tx) => {
    const binding = await loadOwnedBinding(tx, actor, bindingId)
    const [row] = await tx
      .update(discordChannelBindings)
      .set({ summaryEnabled: input.summaryEnabled })
      .where(eq(discordChannelBindings.id, binding.id))
      .returning()
    if (!row) throw notFound()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'discord.binding_update',
      targetType: 'discord_binding',
      targetId: binding.id,
      projectId: binding.projectId,
      metadata: { summaryEnabled: input.summaryEnabled },
    })
    return toBindingDto(row)
  })
}

export async function unbindChannel(db: DbExecutor, actor: Actor, bindingId: unknown, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const binding = await loadOwnedBinding(tx, actor, bindingId)
    await tx.update(discordChannelBindings).set({ unboundAt: now }).where(eq(discordChannelBindings.id, binding.id))
    await tx
      .update(discordPinRequests)
      .set({ status: 'expired', content: null, decidedAt: now })
      .where(and(eq(discordPinRequests.bindingId, binding.id), eq(discordPinRequests.status, 'pending')))
    await deleteMeetingChannelRows(tx, binding.id)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'discord.unbind',
      targetType: 'discord_binding',
      targetId: binding.id,
      projectId: binding.projectId,
    })
  })
}

// ── 봇(내부 API) ──

const bindSchema = z.object({
  discordUserId: snowflake,
  guildId: snowflake,
  channelId: snowflake,
  code: z.string({ error: 'required' }).max(40, { error: 'invalid' }),
  label: z
    .string({ error: 'invalid' })
    .trim()
    .max(100, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v : null)),
})

export const projectUrl = (siteOrigin: string, projectId: string, hash = '') => `${siteOrigin}/projects/${projectId}${hash}`

export async function bindChannel(
  db: DbExecutor,
  rawInput: unknown,
  siteOrigin: string,
  now = new Date(),
): Promise<BindResponse> {
  const input = parseInput(bindSchema, rawInput)
  if (!(await hitRateLimit(db, 'discord-code', input.discordUserId, CODE_RATE_LIMIT, now))) return { status: 'rate_limited' }
  try {
    return await db.transaction(async (tx): Promise<BindResponse> => {
      const code = await findUsableCode(tx, 'bind', input.code, now)
      const integration = await findDiscordIntegration(tx, input.discordUserId)
      if (!integration) return { status: 'not_linked' }
      // 코드 주인과 다른 계정이면 코드가 있다는 사실도 알려 주지 않습니다.
      if (!code?.projectId || code.userId !== integration.userId) return { status: 'invalid_code' }
      const [project] = await tx.select().from(projects).where(eq(projects.id, code.projectId)).limit(1).for('update')
      if (!project) return { status: 'invalid_code' }
      if (!isOwner(await findMembership(tx, project.id, integration.userId))) return { status: 'not_owner' }

      const done = { projectTitle: project.title, projectUrl: projectUrl(siteOrigin, project.id) }
      const existing = await findActiveBinding(tx, input.channelId)
      if (existing) {
        if (existing.projectId !== project.id) return { status: 'channel_taken' }
        await consumeCode(tx, code.id, now)
        return { status: 'already_bound', ...done }
      }
      if (!(await consumeCode(tx, code.id, now))) return { status: 'invalid_code' }
      const [row] = await tx
        .insert(discordChannelBindings)
        .values({
          projectId: project.id,
          guildId: input.guildId,
          channelId: input.channelId,
          label: input.label,
          boundBy: integration.userId,
          createdAt: now,
        })
        .returning({ id: discordChannelBindings.id })
      await recordAudit(tx, {
        actorId: integration.userId,
        action: 'discord.bind',
        targetType: 'discord_binding',
        targetId: row?.id ?? null,
        projectId: project.id,
      })
      return { status: 'bound', ...done }
    })
  } catch (error) {
    if (sqlState(error) === '23505') return { status: 'channel_taken' }
    throw error
  }
}
