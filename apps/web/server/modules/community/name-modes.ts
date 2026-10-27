/**
 * 이름 표시 방식 변경 예약·취소·이력 (C-03, PROOFU_EVOLUTION_PLAN §8.9.4 "이름 표시 방식을 바꿀 때", SYSTEM_DESIGN §6.7 NameModeChange·§8.1·§9.1,
 * DELIVERY_PLAN §4.1 C-03·§5.1 L, ADR 0020).
 *
 * - 예약 `POST /community/spaces/:slug/name-mode-changes {toMode}`: 사용자 방·스터디 방의 **방장(owner)만**. effective_at = 지금 + 7일,
 *   공간마다 예약 하나(409 `change_already_scheduled`), 공식 페이지는 409 `name_mode_fixed`. 예약하는 즉시 그 공간 active 멤버 전원에게 알림.
 *   실명으로 바꾸는데 자유 가입이면 같은 트랜잭션에서 방장 승인으로 바꿉니다(joinPolicyForNameModeChange, 알림에 표시).
 * - 취소 `DELETE …/name-mode-changes/:id`: 방장, effective_at 전에만(409 `already_effective`·`not_scheduled`). 멤버 전원에게 알림.
 *   가입 방식 조정은 되돌리지 않습니다(방장이 설정에서 바꿀 수 있음).
 * - 이력 `GET …/name-mode-changes`: 공간을 읽을 수 있는 사람(사용자 방은 active 멤버). 요청한 사람은 싣지 않습니다.
 * - 적용은 worker(`apps/worker/src/ops/name-modes.ts`)가 합니다. 웹은 적용하지 않지만, effective_at이 지난 예약은 worker 전이라도
 *   지금 방식으로 보여 줍니다(effectiveNameMode). 이미 쓴 글·댓글의 방식은 바꾸지 않습니다(작성 시점 고정, C-04).
 */
import { z } from 'zod'
import {
  NAME_MODES,
  type NameMode,
  canCancelNameModeChange,
  canManageSpace,
  checkNameModeTransition,
  effectiveNameMode,
  isNameModeChangeDue,
  isOfficialKind,
  joinPolicyForNameModeChange,
  nameModeEffectiveAt,
} from '@peerchive/domain'
import { and, communitySpaces, desc, eq, nameModeChanges, type DbExecutor } from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, invalid, notFound, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { type SpaceContext, loadReadableSpace, membershipFacts } from './access'
import { notifyActiveMembers } from './notices'
import type { NameModeChangeDto, NameModeStateDto, PendingNameModeChangeDto } from '../../../shared/types/api'

export type NameModeChangeRow = typeof nameModeChanges.$inferSelect

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)
export const scheduleNameModeSchema = z.object({ toMode: z.enum(NAME_MODES, { error: requiredOr('invalid') }) })

/** 공간의 scheduled 예약(있으면). */
export async function loadScheduledChange(db: DbExecutor, spaceId: string, lock = false): Promise<NameModeChangeRow | null> {
  const query = db
    .select()
    .from(nameModeChanges)
    .where(and(eq(nameModeChanges.spaceId, spaceId), eq(nameModeChanges.status, 'scheduled')))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  return row ?? null
}

const facts = (row: NameModeChangeRow) => ({ status: row.status, toMode: row.toMode, effectiveAt: row.effectiveAt })

/** 지금 효력이 있는 방식(기한이 지난 예약 포함)과 아직 효력이 없는 예약. 공간 상세·이력·C-04 글쓰기가 같은 값을 씁니다. */
export function nameModeNow(currentNameMode: NameMode, scheduled: NameModeChangeRow | null, now: Date): { mode: NameMode; pending: PendingNameModeChangeDto | null } {
  const mode = effectiveNameMode(currentNameMode, scheduled ? facts(scheduled) : null, now)
  const pending = scheduled && !isNameModeChangeDue(facts(scheduled), now) ? toPendingDto(scheduled) : null
  return { mode, pending }
}

function toPendingDto(row: NameModeChangeRow): PendingNameModeChangeDto {
  return { id: row.id, fromMode: row.fromMode, toMode: row.toMode, requestedAt: row.requestedAt.toISOString(), effectiveAt: row.effectiveAt.toISOString() }
}

function toChangeDto(row: NameModeChangeRow): NameModeChangeDto {
  return {
    ...toPendingDto(row),
    status: row.status,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    joinPolicyAdjusted: row.joinPolicyAdjusted,
  }
}

const canChange = (ctx: SpaceContext) => canManageSpace(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), 'change_name_mode')

async function stateFor(db: DbExecutor, ctx: SpaceContext, now: Date): Promise<NameModeStateDto> {
  const fixed = isOfficialKind(ctx.space.row.kind)
  const history = fixed
    ? []
    : await db
        .select()
        .from(nameModeChanges)
        .where(eq(nameModeChanges.spaceId, ctx.space.row.id))
        .orderBy(desc(nameModeChanges.requestedAt), desc(nameModeChanges.id))
        .limit(50)
  const scheduled = history.find((h) => h.status === 'scheduled') ?? null
  const { mode, pending } = nameModeNow(ctx.space.row.currentNameMode, scheduled, now)
  return { currentMode: mode, fixed, canChange: !fixed && canChange(ctx), pending, history: history.map(toChangeDto) }
}

/** GET /community/spaces/:slug/name-mode-changes — 읽을 수 있는 사람만(404). */
export async function getNameModeState(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<NameModeStateDto> {
  const ctx = await loadReadableSpace(db, actor, ref)
  return stateFor(db, ctx, now)
}

/** 공식 페이지 409, 보관·제한 409, 방장이 아니면 403(읽을 수 없으면 이미 404). */
function assertCanChange(ctx: SpaceContext): void {
  if (isOfficialKind(ctx.space.row.kind)) throw conflict('name_mode_fixed')
  if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
  if (!canChange(ctx)) throw forbidden()
}

/**
 * POST /community/spaces/:slug/name-mode-changes {toMode} — 201 + 이력 상태. 401, 403(방장 아님), 404(읽을 수 없음),
 * 409 `name_mode_fixed`·`space_not_active`·`change_already_scheduled`, 422 `toMode: required|invalid|same_mode`.
 */
export async function scheduleNameModeChange(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<NameModeStateDto> {
  const input = parseInput(scheduleNameModeSchema, rawInput)
  return db.transaction(async (tx) => {
    // 공간 행을 먼저 잠급니다(worker 적용·다른 예약과 같은 순서).
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanChange(ctx)
    const space = ctx.space.row
    const existing = await loadScheduledChange(tx, space.id, true)
    if (existing) throw conflict('change_already_scheduled', { changeId: existing.id, effectiveAt: existing.effectiveAt.toISOString() })
    const transition = checkNameModeTransition(space.kind, space.currentNameMode, input.toMode)
    if (!transition.ok) throw transition.reason === 'fixed' ? conflict('name_mode_fixed') : invalid({ toMode: transition.reason })
    const joinPolicy = joinPolicyForNameModeChange(input.toMode, space.joinPolicy)
    const joinPolicyAdjusted = joinPolicy !== space.joinPolicy
    let row: NameModeChangeRow
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(nameModeChanges)
          .values({
            spaceId: space.id,
            fromMode: space.currentNameMode,
            toMode: input.toMode,
            requestedBy: actor.userId,
            requestedAt: now,
            effectiveAt: nameModeEffectiveAt(now),
            joinPolicyAdjusted,
          })
          .returning()
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('change_already_scheduled')
      throw error
    }
    if (joinPolicyAdjusted) await tx.update(communitySpaces).set({ joinPolicy, updatedAt: now }).where(eq(communitySpaces.id, space.id))
    const notified = await notifyActiveMembers(tx, {
      spaceId: space.id,
      changeId: row.id,
      kind: 'name_mode_scheduled',
      payload: { fromMode: row.fromMode, toMode: row.toMode, effectiveAt: row.effectiveAt.toISOString(), joinPolicyAdjusted },
      now,
    })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.name_mode_schedule',
      targetType: 'community_space',
      targetId: space.id,
      metadata: { changeId: row.id, from: row.fromMode, to: row.toMode, joinPolicyAdjusted, notified },
    })
    await emitAnalytics(tx, { name: 'name_mode_scheduled', actorId: actor.userId, props: { from: row.fromMode, to: row.toMode }, now })
    return stateFor(tx, { ...ctx, space: { ...ctx.space, row: { ...space, joinPolicy } } }, now)
  })
}

/**
 * DELETE /community/spaces/:slug/name-mode-changes/:id — 200 + 이력 상태. 401, 403(방장 아님), 404(공간·예약 없음),
 * 409 `not_scheduled`·`already_effective`·`space_not_active`·`name_mode_fixed`.
 */
export async function cancelNameModeChange(db: DbExecutor, actor: Actor, ref: unknown, changeId: unknown, now = new Date()): Promise<NameModeStateDto> {
  return db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    if (!isUuid(changeId)) throw notFound()
    const [change] = await tx
      .select()
      .from(nameModeChanges)
      .where(and(eq(nameModeChanges.id, changeId.toLowerCase()), eq(nameModeChanges.spaceId, ctx.space.row.id)))
      .limit(1)
      .for('update')
    if (!change) throw notFound()
    assertCanChange(ctx)
    const check = canCancelNameModeChange(facts(change), now)
    if (check !== 'ok') throw conflict(check)
    const updated = await tx
      .update(nameModeChanges)
      .set({ status: 'cancelled', cancelledAt: now, cancelledBy: actor.userId })
      .where(and(eq(nameModeChanges.id, change.id), eq(nameModeChanges.status, 'scheduled')))
      .returning({ id: nameModeChanges.id })
    if (updated.length === 0) throw conflict('not_scheduled')
    const notified = await notifyActiveMembers(tx, {
      spaceId: change.spaceId,
      changeId: change.id,
      kind: 'name_mode_cancelled',
      payload: { fromMode: change.fromMode, toMode: change.toMode, effectiveAt: change.effectiveAt.toISOString() },
      now,
    })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.name_mode_cancel',
      targetType: 'community_space',
      targetId: change.spaceId,
      metadata: { changeId: change.id, from: change.fromMode, to: change.toMode, notified },
    })
    return stateFor(tx, ctx, now)
  })
}
