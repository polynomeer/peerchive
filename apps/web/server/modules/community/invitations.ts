/**
 * 공간 초대 링크 (C-02, PROOFU_EVOLUTION_PLAN §8.9.4 "초대 전용", ADR 0019). 과제 초대(T-03)와 같은 규칙입니다.
 *
 * - owner·admin이 만듭니다(가입 방식과 무관, active 사용자 방·스터디 방만). 토큰은 256비트, SHA-256 해시만 저장하고 원문 URL은 만든 응답에서
 *   한 번만 돌려줍니다. 7일 만료, **한 번만 사용**, 취소 가능. 만료·사용·취소·없음은 모두 같은 410입니다.
 * - 수락은 로그인한 사람이 하고 canJoinSpace(via invite)를 거칩니다: 학교 연결 방은 그 학교 인증, 정원, 이미 멤버(409, 토큰은 그대로 남음).
 *   내보내진 사람도 새 초대로는 다시 들어옵니다.
 * - 초대 미리보기(`POST /community/invitations/preview`)는 방 이름·소개·이름 표시 방식만(멤버·게시판 없음).
 */
import { z } from 'zod'
import { SPACE_INVITATION_TTL_MS, canJoinSpace, isOfficialKind } from '@peerchive/domain'
import { and, desc, eq, spaceInvitations, type DbExecutor } from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, ServiceError, conflict, gone, notFound } from '../errors'
import { generateToken, looksLikeToken, sha256Hex } from '../security/tokens'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { activeMemberCount, findMembership, loadReadableSpace, loadSpace, loadViewer, membershipFacts, spaceFacts } from './access'
import { joinError, upsertMembership } from './memberships'
import { assertCanManage, toSpaceSummary } from './spaces'
import type { JoinResultDto, SpaceInvitationDto, SpaceInvitationPreviewDto } from '../../../shared/types/api'

type InvitationRow = typeof spaceInvitations.$inferSelect

export function spaceInvitationStatus(row: InvitationRow, now: Date): SpaceInvitationDto['status'] {
  if (row.revokedAt) return 'revoked'
  if (row.usedAt) return 'used'
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'pending'
}

const toDto = (row: InvitationRow, now: Date): SpaceInvitationDto => ({
  id: row.id,
  status: spaceInvitationStatus(row, now),
  expiresAt: row.expiresAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  usedAt: row.usedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
})

export interface CreatedSpaceInvitation {
  invitation: SpaceInvitationDto
  /** 원문 토큰. handler가 URL로 만들어 한 번만 응답합니다. 저장·로그 금지. */
  token: string
}

/** POST /community/spaces/:slug/invitations — owner·admin(403), active 방만(409). 201. 공식 페이지는 409 `not_joinable`. */
export async function createSpaceInvitation(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<CreatedSpaceInvitation> {
  return db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    if (isOfficialKind(ctx.space.row.kind)) throw conflict('not_joinable')
    assertCanManage(ctx, 'invite')
    const token = generateToken()
    const [row] = await tx
      .insert(spaceInvitations)
      .values({ spaceId: ctx.space.row.id, tokenHash: sha256Hex(token), createdBy: actor.userId, expiresAt: new Date(now.getTime() + SPACE_INVITATION_TTL_MS), createdAt: now })
      .returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.invitation_create', targetType: 'community_space', targetId: ctx.space.row.id, metadata: { invitationId: row!.id } })
    return { invitation: toDto(row!, now), token }
  })
}

/** GET /community/spaces/:slug/invitations — owner·admin. 최근 50개. */
export async function listSpaceInvitations(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<SpaceInvitationDto[]> {
  const ctx = await loadReadableSpace(db, actor, ref)
  if (isOfficialKind(ctx.space.row.kind)) throw conflict('not_joinable')
  assertCanManage(ctx, 'invite')
  const rows = await db.select().from(spaceInvitations).where(eq(spaceInvitations.spaceId, ctx.space.row.id)).orderBy(desc(spaceInvitations.createdAt)).limit(50)
  return rows.map((r) => toDto(r, now))
}

/** DELETE /community/spaces/:slug/invitations/:id — owner·admin. 이미 끝난 초대도 200. */
export async function revokeSpaceInvitation(db: DbExecutor, actor: Actor, ref: unknown, invitationId: unknown, now = new Date()): Promise<SpaceInvitationDto> {
  if (!isUuid(invitationId)) throw notFound()
  return db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'invite')
    const [row] = await tx
      .select()
      .from(spaceInvitations)
      .where(and(eq(spaceInvitations.id, invitationId.toLowerCase()), eq(spaceInvitations.spaceId, ctx.space.row.id)))
      .limit(1)
      .for('update')
    if (!row) throw notFound()
    if (spaceInvitationStatus(row, now) !== 'pending') return toDto(row, now)
    const [updated] = await tx.update(spaceInvitations).set({ revokedAt: now }).where(eq(spaceInvitations.id, row.id)).returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.invitation_revoke', targetType: 'community_space', targetId: ctx.space.row.id, metadata: { invitationId: row.id } })
    return toDto(updated!, now)
  })
}

/** 쓸 수 있는 초대(아니면 410 — 만료·사용·취소·없음·보관된 방을 구분하지 않음). */
async function loadUsableInvitation(db: DbExecutor, token: unknown, now: Date, lock: boolean): Promise<InvitationRow> {
  if (!looksLikeToken(token)) throw gone()
  const query = db.select().from(spaceInvitations).where(eq(spaceInvitations.tokenHash, sha256Hex(token))).limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row || spaceInvitationStatus(row, now) !== 'pending') throw gone()
  return row
}

/** POST /community/invitations/preview {token} — 초대받은 사람의 방 소개(이름·소개·이름 표시 방식)와 수락 가능 여부. 410, 404 `not_eligible`(학교 자격 없음). */
export async function previewSpaceInvitation(db: DbExecutor, actor: Actor, token: unknown, now = new Date()): Promise<SpaceInvitationPreviewDto> {
  const invitation = await loadUsableInvitation(db, token, now, false)
  const space = await loadSpace(db, invitation.spaceId)
  if (space.row.status !== 'active') throw gone()
  const [viewer, membership, count] = await Promise.all([loadViewer(db, actor), findMembership(db, space.row.id, actor.userId), activeMemberCount(db, space.row.id)])
  const decision = canJoinSpace(viewer, spaceFacts(space, count), membershipFacts(membership), 'invite')
  // 학교 자격이 없는 사람(다른 학교·미인증·해제)에게는 토큰이 있어도 방 이름·소개를 보여 주지 않습니다(C-05, ADR 0021).
  // 404 `not_eligible`: 초대가 쓸 수 있는 상태라는 것만 알려 화면이 학교 인증을 안내합니다.
  if (!decision.ok && decision.reason === 'not_found') throw new ServiceError('NOT_FOUND', 'not_eligible')
  const summary = toSpaceSummary(space, count, null)
  return {
    space: { slug: summary.slug, kind: summary.kind, name: summary.name, description: summary.description, nameMode: summary.nameMode, school: summary.school },
    expiresAt: invitation.expiresAt.toISOString(),
    acceptable: decision.ok,
    reason: decision.ok ? 'ok' : decision.reason === 'already_member' ? 'already_member' : decision.reason === 'full' ? 'full' : 'not_eligible',
  }
}

export const acceptSpaceInvitationSchema = z.object({
  token: z.string({ error: 'required' }).min(1, { error: 'required' }).max(256, { error: 'invalid' }),
})

/**
 * POST /community/invitations/accept {token} — 200 `{status: 'active', space}`. 410(쓸 수 없는 초대), 409 `already_member`·`space_full`,
 * 404(학교 자격 없음 — 초대를 받아도 그 학교 인증이 있어야 함). 성공하면 초대는 used(한 번만).
 */
export async function acceptSpaceInvitation(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<JoinResultDto> {
  const { token } = parseInput(acceptSpaceInvitationSchema, rawInput)
  return db.transaction(async (tx) => {
    const peek = await loadUsableInvitation(tx, token, now, false)
    // 공간 → 초대 순서로 잠급니다.
    const space = await loadSpace(tx, peek.spaceId, true)
    const invitation = await loadUsableInvitation(tx, token, now, true)
    if (space.row.status !== 'active') throw gone()
    const [viewer, membership, count] = await Promise.all([
      loadViewer(tx, actor),
      findMembership(tx, space.row.id, actor.userId, true),
      activeMemberCount(tx, space.row.id),
    ])
    const decision = canJoinSpace(viewer, spaceFacts(space, count), membershipFacts(membership), 'invite')
    if (!decision.ok) throw joinError(decision.reason)
    await upsertMembership(tx, space.row.id, actor.userId, 'active', membership, now)
    await tx.update(spaceInvitations).set({ usedAt: now, usedBy: actor.userId }).where(eq(spaceInvitations.id, invitation.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.invitation_accept', targetType: 'community_space', targetId: space.row.id, metadata: { invitationId: invitation.id } })
    await emitAnalytics(tx, { name: 'space_joined', actorId: actor.userId, props: { kind: space.row.kind as 'user_room' | 'study_room', policy: 'invite' }, now })
    return { status: 'active', space: toSpaceSummary(space, count + 1, { role: 'member', status: 'active' }) }
  })
}
