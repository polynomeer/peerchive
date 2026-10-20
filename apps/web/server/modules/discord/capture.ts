/**
 * 디스코드 수집: `/log`와 📌 반응 (T-09, PROOFU_EVOLUTION_PLAN §6.5, SYSTEM_DESIGN §12.1, DELIVERY_PLAN 시나리오 B, ADR 0009).
 *
 * 공통
 * - 연결된 채널에서, 연결된(active 계정) 디스코드 사용자가, 그 프로젝트의 active owner/editor일 때만 로그를 만듭니다.
 *   아니면 `not_bound`/`not_linked`/`not_writer`(또는 `not_member`)만 돌려주고 아무것도 저장하지 않습니다.
 * - 로그는 logs.ts의 parseLogInput·insertLog를 그대로 써서 만듭니다(payload 규칙·권한을 나누지 않음). 출처는 `discord`.
 * - 재전송 중복 방지: clientId를 디스코드 id에서 UUID v5로 만듭니다(`/log`는 interaction id, 📌는 메시지 id).
 *   같은 요청을 몇 번 보내도 (project, author, clientId)가 같아 로그는 하나입니다.
 *
 * `/log <태그> <내용>`
 * - 🔨진행·🔁회고·🗣️회의: 내용이 본문. 🧱막힘: 내용(200자까지)이 증상, 막힌 시간은 고르지 않으면 `lt30m`.
 * - ⚖️결정·✅검증: 봇이 모달로 필수 필드를 받아 `fields`로 보냅니다. 💡해결은 막힘 연결이 필요해 `web_only`.
 * - 검증 실패는 `invalid` + 필드별 코드(빌드 로그 규칙 그대로).
 *
 * 📌 반응
 * - 반응한 사람이 메시지 작성자 본인이면 바로 🔨진행 로그(메시지 id로 한 번만).
 * - 남이 달면 작성자에게 승인 요청(48시간). 작성자가 승인해야 작성자 이름의 로그가 생기고, 승인 전에는 로그가 없습니다.
 *   요청에는 승인 때 로그를 만들 메시지 내용을 잠시 두며, 승인·거절·만료되면 바로 지웁니다(DB check로도 강제).
 * - 첨부 파일은 옮기지 않고 본문 끝에 개수만 적습니다. 원문 메시지 링크(저장된 서버·채널·메시지 id로 만듦)를 근거 링크로 붙입니다.
 */
import { z } from 'zod'
import { canWriteLog } from '@peerchive/domain'
import { and, discordPinRequests, eq, logEntries, lte, sql, type DbExecutor } from '@peerchive/db'
import type {
  LogRequest,
  LogResponse,
  PinDecisionResponse,
  PinRequest,
  PinResponse,
} from '@peerchive/bot-protocol'
import { recordAudit } from '../audit/audit'
import { ServiceError } from '../errors'
import { BODY_MAX, TIME_BUCKETS } from '../logs/payloads'
import { insertLog, parseLogInput, type ParsedLogInput } from '../logs/logs'
import { findMembership, type ProjectContext, loadReadableProject } from '../projects/access'
import { parseInput } from '../validation'
import { findDiscordIntegration, snowflake } from './accounts'
import { type BindingRow, findActiveBinding, projectUrl } from './bindings'
import { discordInteractionClientId, discordMessageClientId } from './client-id'

export const PIN_REQUEST_TTL_MS = 48 * 60 * 60 * 1000
const SYMPTOM_MAX = 200
const PREVIEW_MAX = 200

const logUrl = (siteOrigin: string, projectId: string, logId: string) => projectUrl(siteOrigin, projectId, `#log-${logId}`)

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** 쓸 수 있는 멤버의 프로젝트 컨텍스트. 아니면 null(이유를 밝히지 않음). */
async function writerContext(db: DbExecutor, userId: string, projectId: string): Promise<ProjectContext | null> {
  try {
    const context = await loadReadableProject(db, { userId }, projectId)
    return canWriteLog({ userId }, context.project, context.membership) ? context : null
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'NOT_FOUND') return null
    throw error
  }
}

/** 검증 실패(422)는 필드별 코드로, 그 밖의 서비스 오류는 그대로. */
function validationFields(error: unknown): Record<string, string> | null {
  return error instanceof ServiceError && error.code === 'VALIDATION' ? (error.fields ?? { _: 'invalid' }) : null
}

// ── /log ─────────────────────────────────────────────────────────────────

const logSchema = z.object({
  interactionId: snowflake,
  guildId: snowflake,
  channelId: snowflake,
  discordUserId: snowflake,
  tag: z.enum(['progress', 'stuck', 'solution', 'decision', 'meeting', 'validation', 'retro'], { error: 'invalid' }),
  text: z.string({ error: 'required' }).max(BODY_MAX, { error: 'too_long' }),
  timeBucket: z.enum(TIME_BUCKETS, { error: 'invalid' }).nullish(),
  fields: z.record(z.string(), z.string().max(BODY_MAX, { error: 'too_long' })).nullish(),
})

const lines = (value: string | undefined) =>
  (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** `/log` 입력 → 빌드 로그 작성 요청(검증은 parseLogInput이 함). 💡해결은 null(웹에서만). */
export function logInputFromDiscord(input: Omit<LogRequest, 'guildId' | 'channelId' | 'discordUserId'>): Record<string, unknown> | null {
  const text = input.text.trim()
  const fields = input.fields ?? {}
  const clientId = discordInteractionClientId(input.interactionId)
  switch (input.tag) {
    case 'progress':
    case 'retro':
    case 'meeting':
      return { tag: input.tag, body: text, clientId }
    case 'stuck':
      return {
        tag: 'stuck',
        body: text.length > SYMPTOM_MAX ? text : '',
        payload: { symptom: truncate(text, SYMPTOM_MAX), timeBucket: input.timeBucket ?? 'lt30m' },
        clientId,
      }
    case 'decision':
      return {
        tag: 'decision',
        body: text,
        payload: { options: lines(fields.options), criteria: fields.criteria ?? '', choice: fields.choice ?? '' },
        clientId,
      }
    case 'validation':
      return {
        tag: 'validation',
        body: text,
        payload: { target: fields.target ?? '', conditions: fields.conditions ?? '', result: fields.result ?? '' },
        clientId,
      }
    case 'solution':
      return null
  }
}

export async function captureLog(db: DbExecutor, rawInput: unknown, siteOrigin: string, now = new Date()): Promise<LogResponse> {
  const input = parseInput(logSchema, rawInput)
  const binding = await findActiveBinding(db, input.channelId, input.guildId)
  if (!binding) return { status: 'not_bound' }
  const integration = await findDiscordIntegration(db, input.discordUserId)
  if (!integration) return { status: 'not_linked' }
  const context = await writerContext(db, integration.userId, binding.projectId)
  if (!context) return { status: 'not_writer' }
  const project = projectUrl(siteOrigin, binding.projectId)

  const raw = logInputFromDiscord(input)
  if (!raw) return { status: 'web_only', projectUrl: project }
  let parsed: ParsedLogInput
  try {
    parsed = parseLogInput(raw, now)
  } catch (error) {
    const fields = validationFields(error)
    if (fields) return { status: 'invalid', fields, projectUrl: project }
    throw error
  }
  try {
    const { log, created } = await db.transaction((tx) =>
      insertLog(tx, { userId: integration.userId }, context.project, context.membership, parsed, 'discord', now),
    )
    return { status: created ? 'created' : 'duplicate', logUrl: logUrl(siteOrigin, binding.projectId, log.id) }
  } catch (error) {
    const fields = validationFields(error)
    if (fields) return { status: 'invalid', fields, projectUrl: project }
    if (error instanceof ServiceError && error.code === 'FORBIDDEN') return { status: 'not_writer' }
    throw error
  }
}

// ── 📌 반응 ──────────────────────────────────────────────────────────────

const pinSchema = z.object({
  guildId: snowflake,
  channelId: snowflake,
  messageId: snowflake,
  messageAuthorId: snowflake,
  reactorId: snowflake,
  content: z.string({ error: 'invalid' }).max(8000, { error: 'too_long' }).default(''),
  attachmentCount: z.number({ error: 'invalid' }).int().min(0).max(100).default(0),
  messageUrl: z.string({ error: 'invalid' }).max(300).nullish(),
})

/** 메시지 → 🔨진행 로그 본문(첨부는 개수만). 내용이 없으면 null. */
export function pinBody(content: string, attachmentCount: number): string | null {
  const note = attachmentCount > 0 ? `\n\n📎 첨부 ${attachmentCount}개는 디스코드에만 있습니다.` : ''
  const text = content.trim()
  if (!text) return note ? note.trim() : null
  return truncate(text, BODY_MAX - note.length) + note
}

/** 원문 메시지 링크(근거 링크). 봇이 보낸 URL 대신 저장된 id로 만듭니다. */
const messageLink = (binding: BindingRow, messageId: string) => ({
  url: `https://discord.com/channels/${binding.guildId}/${binding.channelId}/${messageId}`,
  title: '디스코드 메시지',
})

async function createPinLog(
  db: DbExecutor,
  authorUserId: string,
  context: ProjectContext,
  binding: BindingRow,
  messageId: string,
  body: string,
  now: Date,
) {
  const parsed = parseLogInput(
    { tag: 'progress', body, links: [messageLink(binding, messageId)], clientId: discordMessageClientId(messageId) },
    now,
  )
  return insertLog(db, { userId: authorUserId }, context.project, context.membership, parsed, 'discord', now)
}

async function existingPinLog(db: DbExecutor, projectId: string, authorUserId: string, messageId: string) {
  const [row] = await db
    .select({ id: logEntries.id })
    .from(logEntries)
    .where(
      and(
        eq(logEntries.projectId, projectId),
        eq(logEntries.authorId, authorUserId),
        eq(logEntries.clientId, discordMessageClientId(messageId)),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

export async function capturePin(db: DbExecutor, rawInput: unknown, siteOrigin: string, now = new Date()): Promise<PinResponse> {
  const input = parseInput(pinSchema, rawInput)
  const binding = await findActiveBinding(db, input.channelId, input.guildId)
  if (!binding) return { status: 'not_bound' }
  const reactor = await findDiscordIntegration(db, input.reactorId)
  if (!reactor) return { status: 'not_linked' }
  const body = pinBody(input.content, input.attachmentCount)

  // 본인 메시지: 바로 로그.
  if (input.reactorId === input.messageAuthorId) {
    const context = await writerContext(db, reactor.userId, binding.projectId)
    if (!context) return { status: 'not_member' }
    if (!body) return { status: 'empty' }
    const { log, created } = await db.transaction((tx) =>
      createPinLog(tx, reactor.userId, context, binding, input.messageId, body, now),
    )
    return { status: created ? 'created' : 'duplicate', logUrl: logUrl(siteOrigin, binding.projectId, log.id) }
  }

  // 남의 메시지: 요청한 사람은 active 멤버, 작성자는 연결된 owner/editor여야 합니다.
  const requesterMembership = await findMembership(db, binding.projectId, reactor.userId)
  if (requesterMembership?.status !== 'active') return { status: 'not_member' }
  const author = await findDiscordIntegration(db, input.messageAuthorId)
  const authorContext = author ? await writerContext(db, author.userId, binding.projectId) : null
  if (!author || !authorContext) return { status: 'author_unavailable' }
  if (!body) return { status: 'empty' }
  if (await existingPinLog(db, binding.projectId, author.userId, input.messageId)) return { status: 'duplicate' }

  return db.transaction(async (tx): Promise<PinResponse> => {
    const expiresAt = new Date(now.getTime() + PIN_REQUEST_TTL_MS)
    const values = {
      bindingId: binding.id,
      messageId: input.messageId,
      channelId: input.channelId,
      authorExternalId: input.messageAuthorId,
      authorUserId: author.userId,
      requesterUserId: reactor.userId,
      content: body,
      status: 'pending' as const,
      expiresAt,
      decidedAt: null,
      createdAt: now,
    }
    const [current] = await tx
      .select()
      .from(discordPinRequests)
      .where(eq(discordPinRequests.messageId, input.messageId))
      .limit(1)
      .for('update')
    let requestId: string
    if (current) {
      const live = current.status === 'pending' && current.expiresAt > now
      if (live) return { status: 'already_requested' }
      if (current.status === 'approved' || current.status === 'rejected') return { status: 'already_decided' }
      // 만료된 요청은 새 요청으로 다시 엽니다.
      await tx.update(discordPinRequests).set(values).where(eq(discordPinRequests.id, current.id))
      requestId = current.id
    } else {
      const [row] = await tx
        .insert(discordPinRequests)
        .values(values)
        .onConflictDoNothing({ target: discordPinRequests.messageId })
        .returning({ id: discordPinRequests.id })
      if (!row) return { status: 'already_requested' }
      requestId = row.id
    }
    await recordAudit(tx, {
      actorId: reactor.userId,
      action: 'discord.pin_request',
      targetType: 'discord_pin_request',
      targetId: requestId,
      projectId: binding.projectId,
    })
    return {
      status: 'approval_requested',
      approval: {
        requestId,
        authorDiscordId: input.messageAuthorId,
        expiresAt: expiresAt.toISOString(),
        preview: truncate(body.replace(/\s+/g, ' ').trim(), PREVIEW_MAX),
        projectTitle: authorContext.project.title,
      },
    }
  })
}

const decisionSchema = z.object({
  requestId: z.uuid({ error: 'invalid' }),
  discordUserId: snowflake,
  decision: z.enum(['approve', 'reject'], { error: 'invalid' }),
})

/** 만료된 승인 요청을 닫고 저장했던 메시지 내용을 지웁니다. 지운 개수. */
export async function expirePinRequests(db: DbExecutor, now = new Date()): Promise<number> {
  const rows = await db
    .update(discordPinRequests)
    .set({ status: 'expired', content: null, decidedAt: now })
    .where(and(eq(discordPinRequests.status, 'pending'), lte(discordPinRequests.expiresAt, now)))
    .returning({ id: discordPinRequests.id })
  return rows.length
}

/**
 * 작성자의 승인·거절. 버튼을 누른 사람이 작성자가 아니면 없는 요청과 같은 `not_found`.
 * 승인 때 작성자가 더는 연결·쓰기 권한이 없거나 채널 연결이 풀렸으면 `author_unavailable`(요청은 닫고 내용을 지움).
 */
export async function decidePin(db: DbExecutor, rawInput: unknown, siteOrigin: string, now = new Date()): Promise<PinDecisionResponse> {
  const input = parseInput(decisionSchema, rawInput)
  return db.transaction(async (tx): Promise<PinDecisionResponse> => {
    const [request] = await tx
      .select()
      .from(discordPinRequests)
      .where(eq(discordPinRequests.id, input.requestId))
      .limit(1)
      .for('update')
    if (!request || request.authorExternalId !== input.discordUserId) return { status: 'not_found' }
    if (request.status === 'expired') return { status: 'expired' }
    if (request.status !== 'pending') return { status: 'already_decided' }
    const close = (status: 'approved' | 'rejected' | 'expired', logEntryId: string | null = null) =>
      tx
        .update(discordPinRequests)
        .set({ status, content: null, decidedAt: now, logEntryId })
        .where(eq(discordPinRequests.id, request.id))
    const audit = (decision: string) =>
      recordAudit(tx, {
        actorId: request.authorUserId,
        action: 'discord.pin_decision',
        targetType: 'discord_pin_request',
        targetId: request.id,
        metadata: { decision },
      })

    if (request.expiresAt <= now) {
      await close('expired')
      return { status: 'expired' }
    }
    if (input.decision === 'reject') {
      await close('rejected')
      await audit('rejected')
      return { status: 'rejected' }
    }

    const binding: BindingRow | null = await findActiveBinding(tx, request.channelId)
    const author = await findDiscordIntegration(tx, input.discordUserId)
    const context =
      binding && author && author.userId === request.authorUserId
        ? await writerContext(tx, author.userId, binding.projectId)
        : null
    if (!binding || !context || !request.content) {
      await close('expired')
      return { status: 'author_unavailable' }
    }
    const { log } = await createPinLog(tx, request.authorUserId, context, binding, request.messageId, request.content, now)
    await close('approved', log.id)
    await audit('approved')
    return { status: 'approved', logUrl: logUrl(siteOrigin, binding.projectId, log.id) }
  })
}

/** 테스트·운영 확인용: 승인 대기 요청 중 내용이 남은 것의 수(결정·만료된 요청에는 0이어야 함). */
export async function countStoredPinContent(db: DbExecutor, messageId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discordPinRequests)
    .where(and(eq(discordPinRequests.messageId, messageId), sql`${discordPinRequests.content} is not null`))
  return row?.n ?? 0
}
