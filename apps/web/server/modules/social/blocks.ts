/**
 * 차단·뮤트 (S-04, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 Block·Mute·§8.3·§9.2, DELIVERY_PLAN §4.2 S-04·§5.2 U, ADR 0033).
 *
 * social 모듈입니다: 커뮤니티 글 테이블·커뮤니티 모듈을 import하지 않습니다(S-02 경계 테스트). 그래서 **차단은 0~1단계(익명) 커뮤니티 글에
 * 닿을 길이 없습니다** — 익명 글이 차단으로 사라지면 그 자체가 작성자 추정 단서가 되기 때문입니다(§6.7.1 Block).
 *
 * - **차단은 페르소나 페이지에서** 겁니다: 대상은 handle(그 페르소나), 주체는 내가 고른 내 페르소나(`as`). 대상의 사용자 id는 서버에만 저장하고
 *   어떤 응답에도 싣지 않습니다. 내 차단 목록에는 내가 차단한 그 페르소나만 보입니다(상대의 다른 페르소나를 드러내지 않음).
 * - 숨김 범위는 기본 `origin_persona`(차단을 건 내 페르소나만), `all_personas`는 고를 때만. 내게 다른 페르소나가 있고 연결이 비공개이면
 *   `confirmLinkInference: true` 없이는 422(`BLOCK_LINK_WARNING`)입니다.
 * - **팔로우 삭제 범위**: 숨겨지는 내 페르소나(origin 또는 전부)와 **차단한 그 대상 페르소나 사이의** 양방향 팔로우만 지웁니다. 상대의 다른
 *   페르소나와의 팔로우까지 지우면, 내 목록에서 그 팔로우가 함께 사라지는 것으로 "그 페르소나가 같은 사람"임을 내가 알게 됩니다(ADR 0033).
 *   남는 팔로우는 차단이 있는 동안 상대에게 아무것도 열지 않습니다(숨겨진 페르소나는 404이고, 목록에서도 빠짐).
 * - 차단·해제는 상대에게 알리지 않고, 감사(`social.block`·`social.unblock`)에는 id·종류·범위·확인 플래그만 남깁니다(악용 조사용). 뮤트는
 *   감사하지 않습니다(본인만의 표시 설정).
 * - 뮤트는 팔로우 피드·알림(S-05)에서만 빼며, 지금은 저장과 "내 뮤트 목록"뿐입니다.
 */
import { z } from 'zod'
import { and, blocks, desc, eq, follows, identityLinks, inArray, mutes, or, personas, users, type DbExecutor } from '@peerchive/db'
import { BLOCK_SCOPES, blockNeedsLinkConfirm } from '@peerchive/domain'
import { emitSocialAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound } from '../errors'
import { myActingPersona } from './follows'
import { personaDisplayName, resolvePublicPersona } from './personas'
import { isHiddenFrom } from './relations'
import type { FollowPersonaDto, MyBlockDto, MyBlocksDto, MyMuteDto, MyMutesDto } from '../../../shared/types/api'

type PersonaRow = typeof personas.$inferSelect

/** 차단·뮤트 대상: handle로 찾은 공개 페르소나. 없거나, 그 주인이 나를 차단해 내게 숨겨졌으면 404(내가 볼 수 없는 페이지에서는 걸 수 없음). */
async function targetOr404(db: DbExecutor, actor: Actor, rawHandle: unknown) {
  const found = await resolvePublicPersona(db, rawHandle)
  if (await isHiddenFrom(db, found.persona, actor.userId)) throw notFound()
  return found
}

const toTarget = (persona: Pick<PersonaRow, 'kind' | 'handle' | 'displayName'>, accountName: string): FollowPersonaDto => ({
  kind: persona.kind,
  handle: persona.handle,
  displayName: personaDisplayName(persona, accountName),
})

// ── 차단 ─────────────────────────────────────────────────────────────────

const blockInput = z.object({
  handle: z.unknown(),
  as: z.unknown(),
  scope: z.enum(BLOCK_SCOPES, { error: 'invalid' }).default('origin_persona'),
  confirmLinkInference: z.boolean({ error: 'invalid' }).optional(),
})

/**
 * POST /blocks {handle, as, scope?, confirmLinkInference?} — 그 페르소나 페이지에서 차단합니다(201). 같은 (내 페르소나, 대상 페르소나)를 다시
 * 차단하면 범위만 바꿉니다. 404: 없는 handle·내게 숨겨진 대상. 422: `as: invalid`(내 페르소나가 아님), `scope: invalid`,
 * `confirmLinkInference: required`(all_personas + 다른 페르소나 있음 + 연결 비공개). 409 `own_persona`.
 * 숨겨지는 내 페르소나와 대상 페르소나 사이의 양방향 팔로우를 지웁니다(알림 없음).
 */
export async function createBlock(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<MyBlockDto> {
  const parsed = blockInput.safeParse(rawInput ?? {})
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? 'input')] = 'invalid'
    throw invalid(fields)
  }
  const input = parsed.data
  return db.transaction(async (tx) => {
    const { persona: target, displayName } = await targetOr404(tx, actor, input.handle)
    const origin = await myActingPersona(tx, actor, input.as)
    if (!origin) throw invalid({ as: 'invalid' })
    if (target.userId === actor.userId) throw conflict('own_persona')
    const mine = await tx.select({ id: personas.id }).from(personas).where(eq(personas.userId, actor.userId))
    const [link] = await tx.select({ visible: identityLinks.visible }).from(identityLinks).where(eq(identityLinks.userId, actor.userId)).limit(1)
    const linkFacts = { hasOtherPersona: mine.length > 1, visible: link?.visible ?? false }
    if (blockNeedsLinkConfirm(input.scope, linkFacts) && input.confirmLinkInference !== true) throw invalid({ confirmLinkInference: 'required' })

    const [row] = await tx
      .insert(blocks)
      .values({
        blockerUserId: actor.userId,
        blockedUserId: target.userId,
        originPersonaId: origin.id,
        blockedPersonaId: target.id,
        scope: input.scope,
        createdAt: now,
      })
      .onConflictDoUpdate({ target: [blocks.blockerUserId, blocks.originPersonaId, blocks.blockedPersonaId], set: { scope: input.scope } })
      .returning()
    // 숨겨지는 내 페르소나 ↔ 차단한 그 대상 페르소나 사이의 양방향 팔로우만(상대의 다른 페르소나는 건드리지 않음, 위 머리말).
    const hidden = input.scope === 'all_personas' ? mine.map((m) => m.id) : [origin.id]
    await tx
      .delete(follows)
      .where(
        or(
          and(inArray(follows.followerPersonaId, hidden), eq(follows.followeePersonaId, target.id)),
          and(eq(follows.followerPersonaId, target.id), inArray(follows.followeePersonaId, hidden)),
        ),
      )
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'social.block',
      targetType: 'persona',
      targetId: target.id,
      metadata: {
        originPersonaId: origin.id,
        originKind: origin.kind,
        targetKind: target.kind,
        scope: input.scope,
        linkConfirmed: input.confirmLinkInference === true,
      },
    })
    // §6.2 block_created(scope): 상대방 키·페르소나 없음.
    await emitSocialAnalytics(tx, { name: 'block_created', actorId: actor.userId, props: { scope: input.scope }, now })
    return {
      id: row!.id,
      target: { kind: target.kind, handle: target.handle, displayName },
      origin: { kind: origin.kind, handle: origin.handle },
      scope: row!.scope,
      createdAt: row!.createdAt.toISOString(),
    }
  })
}

/** DELETE /blocks/:id — 내 차단 해제(지운 팔로우는 되살리지 않음, 알림 없음). 남의 것·없는 id 404. 감사 `social.unblock`. */
export async function removeBlock(db: DbExecutor, actor: Actor, rawId: unknown): Promise<{ removed: true }> {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(blocks)
      .where(and(eq(blocks.id, id.data.toLowerCase()), eq(blocks.blockerUserId, actor.userId)))
      .returning()
    if (!row) throw notFound()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'social.unblock',
      targetType: 'persona',
      targetId: row.blockedPersonaId,
      metadata: { originPersonaId: row.originPersonaId, scope: row.scope },
    })
    return { removed: true as const }
  })
}

/** GET /me/blocks — 내 차단 목록. 대상은 내가 차단한 그 페르소나의 지금 handle·이름·종류만. */
export async function listMyBlocks(db: DbExecutor, actor: Actor): Promise<MyBlocksDto> {
  const rows = await db
    .select({ block: blocks, target: personas, accountName: users.displayName })
    .from(blocks)
    .innerJoin(personas, eq(personas.id, blocks.blockedPersonaId))
    .innerJoin(users, eq(users.id, personas.userId))
    .where(eq(blocks.blockerUserId, actor.userId))
    .orderBy(desc(blocks.createdAt))
  const origins = rows.length
    ? await db.select({ id: personas.id, kind: personas.kind, handle: personas.handle }).from(personas).where(eq(personas.userId, actor.userId))
    : []
  return {
    blocks: rows.map(({ block, target, accountName }) => {
      const origin = origins.find((o) => o.id === block.originPersonaId)!
      return {
        id: block.id,
        target: toTarget(target, accountName),
        origin: { kind: origin.kind, handle: origin.handle },
        scope: block.scope,
        createdAt: block.createdAt.toISOString(),
      }
    }),
  }
}

// ── 뮤트 ─────────────────────────────────────────────────────────────────

/**
 * POST /mutes {handle} — 그 페르소나를 뮤트(201, 이미 있으면 그대로). 팔로우 피드·알림(S-05)에서만 빠지며 상대에게 알리지 않습니다. 감사 없음.
 * 404: 없는 handle·내게 숨겨진 대상. 409 `own_persona`.
 */
export async function createMute(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<MyMuteDto> {
  const handle = (rawInput as { handle?: unknown } | null)?.handle
  return db.transaction(async (tx) => {
    const { persona: target, displayName } = await targetOr404(tx, actor, handle)
    if (target.userId === actor.userId) throw conflict('own_persona')
    const inserted = await tx
      .insert(mutes)
      .values({ muterUserId: actor.userId, mutedPersonaId: target.id, mutedUserId: target.userId, createdAt: now })
      .onConflictDoNothing({ target: [mutes.muterUserId, mutes.mutedPersonaId] })
      .returning({ id: mutes.id })
    // §6.2 mute_created: 새로 뮤트했을 때만, 상대방 키 없음.
    if (inserted.length) await emitSocialAnalytics(tx, { name: 'mute_created', actorId: actor.userId, now })
    const [row] = await tx
      .select()
      .from(mutes)
      .where(and(eq(mutes.muterUserId, actor.userId), eq(mutes.mutedPersonaId, target.id)))
      .limit(1)
    return { id: row!.id, target: { kind: target.kind, handle: target.handle, displayName }, createdAt: row!.createdAt.toISOString() }
  })
}

/** DELETE /mutes/:id — 뮤트 해제. 남의 것·없는 id 404. */
export async function removeMute(db: DbExecutor, actor: Actor, rawId: unknown): Promise<{ removed: true }> {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  const [row] = await db
    .delete(mutes)
    .where(and(eq(mutes.id, id.data.toLowerCase()), eq(mutes.muterUserId, actor.userId)))
    .returning({ id: mutes.id })
  if (!row) throw notFound()
  return { removed: true }
}

/** GET /me/mutes — 내 뮤트 목록(지금은 이것만 보임, 피드 제외는 S-05). */
export async function listMyMutes(db: DbExecutor, actor: Actor): Promise<MyMutesDto> {
  const rows = await db
    .select({ mute: mutes, target: personas, accountName: users.displayName })
    .from(mutes)
    .innerJoin(personas, eq(personas.id, mutes.mutedPersonaId))
    .innerJoin(users, eq(users.id, personas.userId))
    .where(eq(mutes.muterUserId, actor.userId))
    .orderBy(desc(mutes.createdAt))
  return { mutes: rows.map(({ mute, target, accountName }) => ({ id: mute.id, target: toTarget(target, accountName), createdAt: mute.createdAt.toISOString() })) }
}
