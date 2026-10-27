/**
 * 공간 멤버십: 가입·나가기·승인·거절·역할·내보내기·방장 승계 (C-02, PROOFU_EVOLUTION_PLAN §8.9.4, SYSTEM_DESIGN §6.7 SpaceMembership·§8.1, ADR 0019).
 *
 * - 가입(canJoinSpace): open → active, approval → pending, invite → 403 `invite_only`(초대 링크로만). 정원이 차면 409 `space_full`.
 *   공식 페이지는 가입이 없습니다(409 `not_joinable`, 자격은 학교 인증). 내보내지거나 거절된 사람은 스스로 다시 들어올 수 없습니다(403 `removed`).
 * - 승인·거절·내보내기: owner·admin(admin은 moderator·member만 내보냄). 거절과 내보내기는 removed(새 초대로만 다시 들어옴).
 * - 역할 변경: owner만. role owner를 주면 소유권 이전(이전 owner는 admin).
 * - 나가기: owner가 나가면 가장 오래된 admin → 가장 오래된 다른 active 멤버에게 넘기고, 아무도 없으면 방을 보관(archived)합니다.
 *   탈퇴 정리(worker purge)도 같은 규칙(chooseOwnerSuccessor)을 씁니다.
 * - 멤버 목록은 owner·admin만 봅니다(이름·핸들·역할·가입 시각). 공식 페이지에는 멤버 목록이 없습니다.
 * 공간 행 → 멤버십 순서로 잠급니다(정원·승계 경쟁 방지).
 */
import { z } from 'zod'
import {
  ASSIGNABLE_SPACE_ROLES,
  canJoinSpace,
  canReadSpace,
  canRemoveSpaceMember,
  chooseOwnerSuccessor,
  hasRoomFor,
  isOfficialKind,
  type JoinDecision,
} from '@peerchive/domain'
import { and, asc, eq, inArray, profiles, spaceMemberships, users, type DbExecutor } from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, ServiceError, conflict, forbidden, notFound } from '../errors'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { type MembershipRow, type SpaceContext, findMembership, loadReadableSpace, loadSpaceContext, membershipFacts } from './access'
import { archiveSpaceInTx, assertCanManage, toSpaceSummary } from './spaces'
import type { JoinResultDto, SpaceMemberDto, SpaceMembersDto } from '../../../shared/types/api'

/** 가입 판정 실패를 HTTP 오류로. 존재를 숨겨야 하는 경우는 404. */
export function joinError(reason: Extract<JoinDecision, { ok: false }>['reason']): ServiceError {
  switch (reason) {
    case 'not_found':
      return notFound()
    case 'not_joinable':
      return conflict('not_joinable')
    case 'already_member':
      return conflict('already_member')
    case 'already_pending':
      return conflict('already_pending')
    case 'removed':
      return forbidden('removed')
    case 'invite_only':
      return forbidden('invite_only')
    case 'full':
      return conflict('space_full')
  }
}

/** 멤버십을 active(또는 pending)로 넣거나 되살립니다. 역할은 member로 시작합니다. */
export async function upsertMembership(tx: DbExecutor, spaceId: string, userId: string, status: 'active' | 'pending', existing: MembershipRow | null, now: Date) {
  const values = {
    role: 'member' as const,
    status,
    joinedAt: status === 'active' ? now : null,
    requestedAt: status === 'pending' ? now : null,
    endedAt: null,
    updatedAt: now,
  }
  if (existing) {
    await tx.update(spaceMemberships).set(values).where(eq(spaceMemberships.id, existing.id))
  } else {
    await tx.insert(spaceMemberships).values({ spaceId, userId, ...values, createdAt: now })
  }
}

/**
 * POST /community/spaces/:slug/join — 200 `{status: active|pending, space}`. 소개를 볼 수 없는 공간이면 404.
 * 409 `already_member`·`already_pending`·`space_full`·`not_joinable`, 403 `invite_only`·`removed`.
 */
export async function joinSpace(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<JoinResultDto> {
  return db.transaction(async (tx) => {
    const ctx = await loadSpaceContext(tx, actor, ref, true)
    const decision = canJoinSpace(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), 'self')
    if (!decision.ok) throw joinError(decision.reason)
    await upsertMembership(tx, ctx.space.row.id, actor.userId, decision.status, ctx.membership, now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: decision.status === 'active' ? 'community.member_join' : 'community.member_request',
      targetType: 'community_space',
      targetId: ctx.space.row.id,
      metadata: { policy: ctx.space.row.joinPolicy },
    })
    if (decision.status === 'active') {
      await emitAnalytics(tx, {
        name: 'space_joined',
        actorId: actor.userId,
        props: { kind: ctx.space.row.kind as 'user_room' | 'study_room', policy: ctx.space.row.joinPolicy },
        now,
      })
    }
    const count = ctx.facts.activeMembers + (decision.status === 'active' ? 1 : 0)
    return { status: decision.status, space: toSpaceSummary(ctx.space, count, { role: 'member', status: decision.status }) }
  })
}

/**
 * 방장 자리를 넘깁니다(나가기·탈퇴 정리). 넘겨받을 사람이 없으면 공간을 보관합니다. 호출자가 공간 행을 잠근 트랜잭션 안에서 부릅니다.
 * 떠나는 owner의 멤버십 상태는 호출자가 바꿉니다(먼저 바꾸면 active owner unique와 충돌하지 않음).
 */
export async function succeedOwner(tx: DbExecutor, spaceId: string, leavingUserId: string, now: Date): Promise<{ successorId: string | null; archived: boolean }> {
  const members = await tx
    .select({ userId: spaceMemberships.userId, role: spaceMemberships.role, status: spaceMemberships.status, joinedAt: spaceMemberships.joinedAt })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.status, 'active')))
  const successorId = chooseOwnerSuccessor(members, leavingUserId)
  if (successorId) {
    await tx
      .update(spaceMemberships)
      .set({ role: 'owner', updatedAt: now })
      .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.userId, successorId)))
    await recordAudit(tx, {
      actorId: null,
      action: 'community.owner_succession',
      targetType: 'community_space',
      targetId: spaceId,
      metadata: { successorRole: members.find((m) => m.userId === successorId)?.role ?? null },
    })
    return { successorId, archived: false }
  }
  await archiveSpaceInTx(tx, spaceId, now)
  await recordAudit(tx, { actorId: null, action: 'community.space_archive', targetType: 'community_space', targetId: spaceId, metadata: { cause: 'no_successor' } })
  return { successorId: null, archived: true }
}

/**
 * POST /community/spaces/:slug/leave — 200 `{left: true, successor?: 'transferred'|'archived'|null}`. 승인 대기면 요청 취소.
 * 멤버가 아니면 404(공간을 읽을 수 없는 사람) 또는 409 `not_member`.
 */
export async function leaveSpace(
  db: DbExecutor,
  actor: Actor,
  ref: unknown,
  now = new Date(),
): Promise<{ left: true; succession: 'transferred' | 'archived' | null }> {
  return db.transaction(async (tx) => {
    const ctx = await loadSpaceContext(tx, actor, ref, true)
    const m = ctx.membership
    if (!m || (m.status !== 'active' && m.status !== 'pending')) {
      if (canReadSpace(ctx.viewer, ctx.facts, membershipFacts(m))) throw conflict('not_member')
      throw notFound()
    }
    await tx.update(spaceMemberships).set({ status: 'left', role: 'member', endedAt: now, updatedAt: now }).where(eq(spaceMemberships.id, m.id))
    let succession: 'transferred' | 'archived' | null = null
    if (m.status === 'active' && m.role === 'owner') {
      const result = await succeedOwner(tx, ctx.space.row.id, actor.userId, now)
      succession = result.archived ? 'archived' : 'transferred'
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: m.status === 'pending' ? 'community.member_request_cancel' : 'community.member_leave',
      targetType: 'community_space',
      targetId: ctx.space.row.id,
      metadata: { role: m.role, succession },
    })
    return { left: true, succession }
  })
}

// ── 관리 ─────────────────────────────────────────────────────────────────

async function memberDtos(db: DbExecutor, rows: MembershipRow[]): Promise<SpaceMemberDto[]> {
  if (rows.length === 0) return []
  const people = await db
    .select({ id: users.id, displayName: users.displayName, handle: profiles.handle })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(inArray(users.id, rows.map((r) => r.userId)))
  const byId = new Map(people.map((p) => [p.id, p]))
  return rows.map((r) => ({
    userId: r.userId,
    displayName: byId.get(r.userId)?.displayName ?? '',
    handle: byId.get(r.userId)?.handle ?? null,
    role: r.role,
    status: r.status,
    joinedAt: r.joinedAt?.toISOString() ?? null,
    requestedAt: r.requestedAt?.toISOString() ?? null,
  }))
}

const ROLE_ORDER = { owner: 0, admin: 1, moderator: 2, member: 3 } as const

/** GET /community/spaces/:slug/members — owner·admin만(403). 공식 페이지는 409 `no_member_list`. */
export async function listMembers(db: DbExecutor, actor: Actor, ref: unknown): Promise<SpaceMembersDto> {
  const ctx = await loadReadableSpace(db, actor, ref)
  if (isOfficialKind(ctx.space.row.kind)) throw conflict('no_member_list')
  const m = membershipFacts(ctx.membership)
  // 보관·제한된 방에서도 owner·admin은 목록을 봅니다(관리는 못 함).
  if (!m || m.status !== 'active' || (m.role !== 'owner' && m.role !== 'admin')) throw forbidden()
  const rows = await db
    .select()
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, ctx.space.row.id), inArray(spaceMemberships.status, ['active', 'pending'])))
    .orderBy(asc(spaceMemberships.joinedAt), asc(spaceMemberships.requestedAt), asc(spaceMemberships.createdAt))
  const dtos = await memberDtos(db, rows)
  return {
    members: dtos.filter((d) => d.status === 'active').sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]),
    pending: dtos.filter((d) => d.status === 'pending'),
  }
}

async function loadTarget(tx: DbExecutor, ctx: SpaceContext, userId: unknown): Promise<MembershipRow> {
  if (!isUuid(userId)) throw notFound()
  const target = await findMembership(tx, ctx.space.row.id, userId.toLowerCase(), true)
  if (!target) throw notFound()
  return target
}

/** POST /community/spaces/:slug/members/:userId/approve — owner·admin. 대기 중이 아니면 409 `not_pending`, 정원이 차면 409 `space_full`. */
export async function approveMember(db: DbExecutor, actor: Actor, ref: unknown, userId: unknown, now = new Date()): Promise<SpaceMembersDto> {
  await db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'review_requests')
    const target = await loadTarget(tx, ctx, userId)
    if (target.status !== 'pending') throw conflict('not_pending')
    if (!hasRoomFor(ctx.facts)) throw conflict('space_full')
    await tx
      .update(spaceMemberships)
      .set({ status: 'active', role: 'member', joinedAt: now, updatedAt: now })
      .where(eq(spaceMemberships.id, target.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.member_approve', targetType: 'community_space', targetId: ctx.space.row.id, metadata: {} })
    await emitAnalytics(tx, {
      name: 'space_joined',
      actorId: target.userId,
      props: { kind: ctx.space.row.kind as 'user_room' | 'study_room', policy: 'approval' },
      now,
    })
  })
  return listMembers(db, actor, ref)
}

/** POST /community/spaces/:slug/members/:userId/reject — owner·admin. 거절은 removed(사유 없음, 새 초대로만 다시 들어옴). */
export async function rejectMember(db: DbExecutor, actor: Actor, ref: unknown, userId: unknown, now = new Date()): Promise<SpaceMembersDto> {
  await db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'review_requests')
    const target = await loadTarget(tx, ctx, userId)
    if (target.status !== 'pending') throw conflict('not_pending')
    await tx.update(spaceMemberships).set({ status: 'removed', endedAt: now, updatedAt: now }).where(eq(spaceMemberships.id, target.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.member_reject', targetType: 'community_space', targetId: ctx.space.row.id, metadata: {} })
  })
  return listMembers(db, actor, ref)
}

/** DELETE /community/spaces/:slug/members/:userId — owner(owner 말고 모두)·admin(moderator·member만). 자기 자신은 나가기로(409 `use_leave`). */
export async function removeMember(db: DbExecutor, actor: Actor, ref: unknown, userId: unknown, now = new Date()): Promise<SpaceMembersDto> {
  await db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'remove_members')
    const target = await loadTarget(tx, ctx, userId)
    if (target.userId === actor.userId) throw conflict('use_leave')
    if (target.status !== 'active') throw conflict('not_active_member')
    if (!canRemoveSpaceMember(ctx.membership!.role, target.role)) throw forbidden()
    await tx.update(spaceMemberships).set({ status: 'removed', role: 'member', endedAt: now, updatedAt: now }).where(eq(spaceMemberships.id, target.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.member_remove', targetType: 'community_space', targetId: ctx.space.row.id, metadata: { role: target.role } })
  })
  return listMembers(db, actor, ref)
}

export const changeRoleSchema = z.object({ role: z.enum(ASSIGNABLE_SPACE_ROLES, { error: (i) => (i.input === undefined ? 'required' : 'invalid') }) })

/**
 * PATCH /community/spaces/:slug/members/:userId {role} — owner만(403). 대상은 active 멤버(아니면 409 `not_active_member`).
 * role owner → 소유권 이전(나는 admin). 자기 역할은 바꿀 수 없음(409 `self`).
 */
export async function changeMemberRole(db: DbExecutor, actor: Actor, ref: unknown, userId: unknown, rawInput: unknown, now = new Date()): Promise<SpaceMembersDto> {
  const { role } = parseInput(changeRoleSchema, rawInput)
  await db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'change_roles')
    const target = await loadTarget(tx, ctx, userId)
    if (target.userId === actor.userId) throw conflict('self')
    if (target.status !== 'active') throw conflict('not_active_member')
    if (target.role === role) return
    if (role === 'owner') {
      // 이전 owner를 먼저 내려야 active owner unique를 지킵니다.
      await tx.update(spaceMemberships).set({ role: 'admin', updatedAt: now }).where(eq(spaceMemberships.id, ctx.membership!.id))
    }
    await tx.update(spaceMemberships).set({ role, updatedAt: now }).where(eq(spaceMemberships.id, target.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: role === 'owner' ? 'community.owner_transfer' : 'community.member_role_change',
      targetType: 'community_space',
      targetId: ctx.space.row.id,
      metadata: { from: target.role, to: role },
    })
  })
  // 소유권을 넘기면 나는 admin이므로 목록은 그대로 볼 수 있습니다.
  return listMembers(db, actor, ref)
}
