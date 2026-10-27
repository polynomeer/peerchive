/**
 * 초대 (T-03, §6.3 Invitation).
 *
 * - owner만 생성·조회·취소합니다. 역할은 editor/reviewer/viewer(owner 불가, DB check로도 막음).
 * - 토큰은 256비트, SHA-256 해시만 저장하며 원문 URL은 생성 응답에서 한 번만 돌려줍니다.
 * - 7일 만료, 한 번만 사용, 취소 가능. 만료·사용·취소·없음은 모두 같은 410으로 응답합니다.
 */
import { z } from 'zod'
import { canInvite, canManageMembers, type ProjectRole } from '@peerchive/domain'
import { and, desc, eq, invitations, projectMembers, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, gone, notFound } from '../errors'
import { generateToken, looksLikeToken, sha256Hex } from '../security/tokens'
import { parseInput } from '../validation'
import { assertNotStudyManaged, findMembership, isUuid, loadReadableProject } from './access'
import { ASSIGNABLE_ROLES } from './members'
import type { InvitationDto, InvitationStatus } from '../../../shared/types/api'

export type { InvitationDto, InvitationStatus }

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const createInvitationSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES, { error: 'invalid' }),
})

export const acceptInvitationSchema = z.object({
  token: z.string({ error: 'required' }).min(1, { error: 'required' }).max(256, { error: 'invalid' }),
})
type InvitationRow = typeof invitations.$inferSelect

export function invitationStatus(row: InvitationRow, now: Date): InvitationStatus {
  if (row.revokedAt) return 'revoked'
  if (row.usedAt) return 'used'
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'pending'
}

function toInvitationDto(row: InvitationRow, now: Date): InvitationDto {
  return {
    id: row.id,
    role: row.role,
    status: invitationStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

export interface CreatedInvitation {
  invitation: InvitationDto
  /** 원문 토큰. handler가 URL로 만들어 한 번만 응답합니다. 저장·로그 금지. */
  token: string
}

export async function createInvitation(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<CreatedInvitation> {
  const input = parseInput(createInvitationSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId)
    // 스터디 기록의 멤버는 스터디 방 초대로만 들어옵니다(C-08).
    assertNotStudyManaged(project)
    if (!canInvite({ userId: actor.userId }, project, membership, input.role)) throw forbidden()
    return issueInvitationInTx(tx, { projectId: project.id, role: input.role, createdBy: actor.userId }, now)
  })
}

/**
 * 초대 한 장을 만듭니다(호출자의 트랜잭션, 권한은 호출자가 확인). 웹의 초대 만들기와 C-07 팀원 모집 마감(선정된 지원자의 초대 받기)이 함께 씁니다.
 * 토큰은 해시만 저장하고 원문은 돌려준 값에만 있습니다(한 번만 응답).
 */
export async function issueInvitationInTx(
  tx: DbExecutor,
  input: { projectId: string; role: (typeof ASSIGNABLE_ROLES)[number]; createdBy: string },
  now: Date,
): Promise<CreatedInvitation> {
  const token = generateToken()
  const [row] = await tx
    .insert(invitations)
    .values({
      projectId: input.projectId,
      tokenHash: sha256Hex(token),
      role: input.role,
      createdBy: input.createdBy,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      createdAt: now,
    })
    .returning()
  if (!row) throw new Error('invitation insert failed')
  await recordAudit(tx, {
    actorId: input.createdBy,
    action: 'invitation.create',
    targetType: 'invitation',
    targetId: row.id,
    projectId: input.projectId,
    metadata: { role: input.role },
  })
  return { invitation: toInvitationDto(row, now), token }
}

export async function listInvitations(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  now = new Date(),
): Promise<InvitationDto[]> {
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  if (!canManageMembers({ userId: actor.userId }, project, membership)) throw forbidden()
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.projectId, project.id))
    .orderBy(desc(invitations.createdAt))
    .limit(100)
  return rows.map((row) => toInvitationDto(row, now))
}

/** 아직 사용·취소되지 않은 초대를 취소합니다. 이미 사용·취소됐으면 409. */
export async function revokeInvitation(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  invitationId: unknown,
  now = new Date(),
): Promise<InvitationDto> {
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId)
    if (!canManageMembers({ userId: actor.userId }, project, membership)) throw forbidden()
    if (!isUuid(invitationId)) throw notFound()
    const [row] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, invitationId), eq(invitations.projectId, project.id)))
      .for('update')
      .limit(1)
    if (!row) throw notFound()
    if (row.usedAt || row.revokedAt) throw conflict('invitation_not_pending')
    const [updated] = await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(eq(invitations.id, row.id))
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'invitation.revoke',
      targetType: 'invitation',
      targetId: row.id,
      projectId: project.id,
    })
    return toInvitationDto(updated ?? row, now)
  })
}

/**
 * 로그인한 사용자가 초대를 수락합니다. 이미 active 멤버면 409(토큰은 소비하지 않음).
 * 예전에 나갔거나 내보내진 멤버는 초대의 역할로 다시 active가 됩니다.
 */
export async function acceptInvitation(
  db: DbExecutor,
  actor: Actor,
  rawInput: unknown,
  now = new Date(),
): Promise<{ projectId: string; role: ProjectRole }> {
  const { token } = parseInput(acceptInvitationSchema, rawInput)
  if (!looksLikeToken(token)) throw gone()
  const tokenHash = sha256Hex(token)

  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .for('update')
      .limit(1)
    if (!invitation || invitationStatus(invitation, now) !== 'pending') throw gone()

    const existing = await findMembership(tx, invitation.projectId, actor.userId)
    if (existing?.status === 'active') throw conflict('already_member')

    if (existing) {
      await tx
        .update(projectMembers)
        .set({ role: invitation.role, status: 'active', updatedAt: now })
        .where(and(eq(projectMembers.projectId, invitation.projectId), eq(projectMembers.userId, actor.userId)))
    } else {
      await tx.insert(projectMembers).values({
        projectId: invitation.projectId,
        userId: actor.userId,
        role: invitation.role,
        status: 'active',
      })
    }
    await tx
      .update(invitations)
      .set({ usedAt: now, usedBy: actor.userId })
      .where(eq(invitations.id, invitation.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'invitation.accept',
      targetType: 'invitation',
      targetId: invitation.id,
      projectId: invitation.projectId,
      metadata: { role: invitation.role, rejoined: existing !== null },
    })
    return { projectId: invitation.projectId, role: invitation.role }
  })
}
