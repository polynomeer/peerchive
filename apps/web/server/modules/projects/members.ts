/**
 * 멤버 조회·역할 변경·내보내기·나가기·소유권 이전 (T-03, §8 "팀 멤버 관리").
 *
 * 판정은 @peerchive/domain 정책 함수가 최종 결정합니다. 멤버 변경은 프로젝트 행을 잠근 트랜잭션에서
 * 하므로 동시에 들어온 이전·내보내기 요청이 서로 엇갈리지 않습니다.
 */
import { z } from 'zod'
import {
  canChangeRole,
  canLeave,
  canManageMembers,
  canRemoveMember,
  canTransferOwnership,
  type ProjectRole,
} from '@peerchive/domain'
import { and, asc, eq, sql, profiles, projectMembers, projects, users, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, invalid, notFound } from '../errors'
import { parseInput } from '../validation'
import { assertNotStudyManaged, findMembership, isUuid, loadReadableProject } from './access'
import { loadMemberRefs } from './member-refs'
import type { MemberDto } from '../../../shared/types/api'

export type { MemberDto }

/** 초대·역할 변경으로 줄 수 있는 역할. owner는 이전으로만 넘깁니다. */
export const ASSIGNABLE_ROLES = ['editor', 'reviewer', 'viewer'] as const

export const changeRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES, { error: 'invalid' }),
})

export const transferOwnershipSchema = z.object({
  userId: z.uuid({ error: 'invalid' }),
})
export async function listMembers(db: DbExecutor, actor: Actor, projectId: unknown): Promise<MemberDto[]> {
  const { project } = await loadReadableProject(db, actor, projectId)
  const rows = await db
    .select({
      userId: projectMembers.userId,
      displayName: users.displayName,
      handle: profiles.handle,
      role: projectMembers.role,
      partLabel: projectMembers.partLabel,
      joinedAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .leftJoin(profiles, eq(profiles.userId, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.status, 'active')))
    .orderBy(sql`case ${projectMembers.role} when 'owner' then 0 when 'editor' then 1 when 'reviewer' then 2 else 3 end`, asc(projectMembers.createdAt))
  // 익명 스터디 기록(C-08, ADR 0026 부록)은 다른 멤버의 이름과 id를 가리고, 가입 시각도 싣지 않으며 가입 순서로 늘어놓지 않습니다
  // (방 멤버 목록의 가입 순서·시각과 맞춰 보지 못하게). 순서는 역할, 그 안에서 가린 이름.
  const refs = await loadMemberRefs(db, project, actor.userId)
  const dtos = rows.map((row) => {
    const self = row.userId === actor.userId
    return refs.person({ ...row, joinedAt: refs.pseudonymous && !self ? null : row.joinedAt.toISOString() })
  })
  if (!refs.pseudonymous) return dtos
  const rank = { owner: 0, editor: 1, reviewer: 2, viewer: 3 } as const
  return dtos.sort((x, y) => rank[x.role] - rank[y.role] || x.displayName.localeCompare(y.displayName, 'ko', { numeric: true }) || (x.userId < y.userId ? -1 : 1))
}

/** 역할 변경 대상(본인·owner가 아닌 active 멤버)을 찾습니다. 없으면 404, owner/본인이면 409. */
async function loadTargetMember(db: DbExecutor, actor: Actor, projectId: string, targetUserId: unknown) {
  if (!isUuid(targetUserId)) throw notFound()
  const target = await findMembership(db, projectId, targetUserId)
  if (!target || target.status !== 'active') throw notFound()
  if (target.userId === actor.userId || target.role === 'owner') throw conflict('owner_role_locked')
  return target
}

export async function changeMemberRole(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  targetUserId: unknown,
  rawInput: unknown,
): Promise<MemberDto[]> {
  const input = parseInput(changeRoleSchema, rawInput)
  const id = await db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertNotStudyManaged(project)
    if (!canManageMembers({ userId: actor.userId }, project, membership)) throw forbidden()
    const target = await loadTargetMember(tx, actor, project.id, targetUserId)
    if (!canChangeRole({ userId: actor.userId }, project, membership, target, input.role)) throw forbidden()
    if (target.role !== input.role) {
      await tx
        .update(projectMembers)
        .set({ role: input.role, updatedAt: new Date() })
        .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.userId)))
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'member.role_change',
        targetType: 'member',
        targetId: target.userId,
        projectId: project.id,
        metadata: { from: target.role, to: input.role },
      })
    }
    return project.id
  })
  return listMembers(db, actor, id)
}

/** owner가 멤버를 내보냅니다(status → removed). 기록은 지우지 않습니다. */
export async function removeMember(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  targetUserId: unknown,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertNotStudyManaged(project)
    if (!canManageMembers({ userId: actor.userId }, project, membership)) throw forbidden()
    const target = await loadTargetMember(tx, actor, project.id, targetUserId)
    if (!canRemoveMember({ userId: actor.userId }, project, membership, target)) throw forbidden()
    await tx
      .update(projectMembers)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.userId)))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'member.remove',
      targetType: 'member',
      targetId: target.userId,
      projectId: project.id,
      metadata: { role: target.role },
    })
  })
}

/** 스스로 나가기(status → left). owner는 먼저 소유권을 이전해야 합니다(409 owner_must_transfer). */
export async function leaveProject(db: DbExecutor, actor: Actor, projectId: unknown): Promise<void> {
  await db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertNotStudyManaged(project)
    if (membership.role === 'owner') throw conflict('owner_must_transfer')
    if (!canLeave({ userId: actor.userId }, project, membership)) throw forbidden()
    await tx
      .update(projectMembers)
      .set({ status: 'left', updatedAt: new Date() })
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, actor.userId)))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'member.leave',
      targetType: 'member',
      targetId: actor.userId,
      projectId: project.id,
      metadata: { role: membership.role },
    })
  })
}

/**
 * 소유권 이전: 대상은 owner가 되고 이전 owner는 editor가 됩니다.
 * projects.owner_id와 두 멤버십을 한 트랜잭션에서 바꿉니다.
 */
export async function transferOwnership(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(transferOwnershipSchema, rawInput)
  await db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertNotStudyManaged(project)
    if (!canManageMembers({ userId: actor.userId }, project, membership)) throw forbidden()
    if (input.userId === actor.userId) throw invalid({ userId: 'self' })
    const target = await findMembership(tx, project.id, input.userId)
    if (!target || target.status !== 'active') throw invalid({ userId: 'not_active_member' })
    if (!canTransferOwnership({ userId: actor.userId }, project, membership, target)) throw forbidden()

    const now = new Date()
    await tx
      .update(projectMembers)
      .set({ role: 'owner', updatedAt: now })
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.userId)))
    await tx
      .update(projectMembers)
      .set({ role: 'editor', updatedAt: now })
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, actor.userId)))
    await tx
      .update(projects)
      .set({ ownerId: target.userId, version: sql`${projects.version} + 1`, updatedAt: now })
      .where(eq(projects.id, project.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'project.transfer_ownership',
      targetType: 'project',
      targetId: project.id,
      projectId: project.id,
      metadata: { toUserId: target.userId, previousRoleOfTarget: target.role },
    })
  })
}
