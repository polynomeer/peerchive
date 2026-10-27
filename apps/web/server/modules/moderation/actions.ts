/**
 * 운영 조치 적용·되돌림 (T-15, SYSTEM_DESIGN §7.2·§8, ADR 0015). 모두 호출자의 트랜잭션 안에서 상태 변경 + 조치 행 + outbox + 감사를 함께 남깁니다.
 *
 * | 조치 | 적용 | 되돌림(제한 해제·이의제기) |
 * |---|---|---|
 * | restrict | 공개 published → restricted(도메인 restrict), 지금 release withdrawn, 열린 후보 superseded, access_epoch +1, outbox publication.withdrawn(restricted) | restricted → draft(도메인 lift_restriction). release는 되살리지 않음 |
 * | hide_item | release_hidden_items 한 줄(공개 전체에 적용), access_epoch +1 | lifted_at, access_epoch +1 |
 * | hide_note | 선배 노트 published → hidden | hidden → published(내용은 숨긴 동안 고칠 수 없으므로 그대로) |
 * | hide_case_study | case_studies.hidden_at | hidden_at = null(게시 상태는 그대로) |
 * | hide_profile | profiles.hidden_at | hidden_at = null |
 * | restrict_space | 커뮤니티 공간 active → restricted(C-02, 읽기만·목록·가입·쓰기 중지) | restricted → active |
 * | hide_post·hide_comment | 커뮤니티 글·댓글 published·auto_hidden·(방 운영진이 가린) hidden → hidden(C-04, 본문은 남김) | 다른 가리기가 없으면 hidden → published |
 * | none(커뮤니티 글·댓글) | 신고 누적 임시 숨김(auto_hidden)이면 published로 복원 + 작성자 알림(C-06) | — |
 * | space_hide(C-06, 방 운영진이 community 모듈에서 만듦) | — | 다른 가리기가 없으면 hidden → published |
 * | sanction(C-06, 운영자가 community 모듈에서 발급) | — | 제재 revoked(쓰기 제한 풀림) |
 *
 * 공개 읽기는 이 상태를 요청마다 읽으므로 커밋 즉시 효력이 있습니다(worker 무관). outbox `moderation.action`은 worker가 검색 문서 같은 남은 사본을
 * 맞추는 데만 씁니다. 삭제 조치는 없습니다(차단 ≠ 삭제).
 */
import { type ModerationActionKind, transition } from '@peerchive/domain'
import {
  MODERATION_ACTION_TOPIC,
  and,
  caseStudies,
  eq,
  isNull,
  moderationActions,
  outboxEvents,
  profiles,
  publicationCandidates,
  publications,
  releaseHiddenItems,
  seniorNotes,
  type DbExecutor,
  type ModerationActionOutboxPayload,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { liftSpaceRestrictionInTx, restrictSpaceInTx } from '../community/official'
import { hideCommunityItemInTx, restoreAutoHiddenInTx, revokeSanctionByActionInTx, unhideCommunityItemInTx } from '../community/reporting'
import { conflict, notFound } from '../errors'
import { lockPublication } from '../publication/candidates'
import { liftRestrictionInTx, restrictInTx } from '../publication/releases'
import type { TargetPointer } from './targets'
import type { PublicSnapshot } from '../../../shared/types/api'

export type ActionRow = typeof moderationActions.$inferSelect

export interface ApplyInput {
  kind: ModerationActionKind
  outcome: 'resolved' | 'dismissed'
  internalNote: string
  publicReason: string | null
  notifyOwner: boolean
}

function auditTarget(
  action: Pick<ActionRow, 'targetType' | 'publicationId' | 'seniorNoteId' | 'caseStudyId' | 'profileUserId' | 'communitySpaceId' | 'communityPostId' | 'communityCommentId'>,
) {
  switch (action.targetType) {
    case 'community_space':
      return { targetType: 'community_space' as const, targetId: action.communitySpaceId }
    case 'community_post':
      return { targetType: 'community_post' as const, targetId: action.communityPostId }
    case 'community_comment':
      return { targetType: 'community_comment' as const, targetId: action.communityCommentId }
    case 'publication':
    case 'publication_item':
      return { targetType: 'publication' as const, targetId: action.publicationId }
    case 'senior_note':
      return { targetType: 'senior_note' as const, targetId: action.seniorNoteId }
    case 'case_study':
      return { targetType: 'case_study' as const, targetId: action.caseStudyId }
    case 'profile':
      return { targetType: 'user' as const, targetId: action.profileUserId }
  }
}

async function emit(tx: DbExecutor, actionId: string, phase: ModerationActionOutboxPayload['phase'], now: Date) {
  await tx.insert(outboxEvents).values({ topic: MODERATION_ACTION_TOPIC, payload: { actionId, phase } satisfies ModerationActionOutboxPayload, createdAt: now })
}

function itemExists(snapshot: PublicSnapshot, kind: string, key: string): boolean {
  if (kind === 'log') return snapshot.logs.some((l) => l.key === key)
  if (kind === 'claim') return snapshot.claims.some((c) => c.key === key)
  return snapshot.artifacts.some((a) => a.artifactVersionId === key)
}

/**
 * 조치 행을 만들고 효과를 적용합니다. 대상이 이미 그 조치를 받을 수 없는 상태면 409 `target_not_public`(제한: 게시 중이 아님,
 * 노트: 게시 중이 아님, 케이스·프로필·항목: 이미 숨김). kind 'none'은 행만 남깁니다.
 */
export async function applyModeration(tx: DbExecutor, operatorId: string, target: TargetPointer, input: ApplyInput, now: Date): Promise<ActionRow> {
  let projectId: string | null = null
  // 효과를 적용할 행을 먼저 잠그고 상태를 확인합니다.
  let publication: typeof publications.$inferSelect | null = null
  if (input.kind === 'restrict' || input.kind === 'hide_item') {
    if (!target.publicationId) throw notFound()
    publication = await lockPublication(tx, target.publicationId)
    projectId = publication.projectId
    if (input.kind === 'restrict' && !transition(publication.status, 'restrict', { now }).ok) throw conflict('target_not_public')
    if (input.kind === 'hide_item') {
      const [release] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, target.releaseId!)).limit(1)
      if (!release || !itemExists(release.snapshot as unknown as PublicSnapshot, target.itemKind!, target.itemKey!)) throw notFound()
      const [already] = await tx
        .select({ id: releaseHiddenItems.id })
        .from(releaseHiddenItems)
        .where(
          and(
            eq(releaseHiddenItems.publicationId, publication.id),
            eq(releaseHiddenItems.itemKind, target.itemKind!),
            eq(releaseHiddenItems.itemKey, target.itemKey!),
            isNull(releaseHiddenItems.liftedAt),
          ),
        )
        .limit(1)
      if (already) throw conflict('target_not_public')
    }
  } else if (target.publicationId) {
    const [p] = await tx.select({ projectId: publications.projectId }).from(publications).where(eq(publications.id, target.publicationId)).limit(1)
    projectId = p?.projectId ?? null
  }
  if (input.kind === 'hide_note') {
    const [note] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, target.seniorNoteId!)).limit(1).for('update')
    if (!note) throw notFound()
    if (note.status !== 'published') throw conflict('target_not_public')
  }
  if (input.kind === 'hide_case_study') {
    const [cs] = await tx.select().from(caseStudies).where(eq(caseStudies.id, target.caseStudyId!)).limit(1).for('update')
    if (!cs) throw notFound()
    if (cs.hiddenAt) throw conflict('target_not_public')
  }
  if (input.kind === 'restrict_space') {
    // 효과(공간 제한)는 조치 행을 만든 뒤 restrictSpaceInTx가 적용합니다(active가 아니면 409 target_not_public, 같은 트랜잭션이라 함께 되돌아감).
    if (!target.communitySpaceId) throw notFound()
  }
  if (input.kind === 'hide_post' && !target.communityPostId) throw notFound()
  if (input.kind === 'hide_comment' && !target.communityCommentId) throw notFound()
  if (input.kind === 'hide_profile') {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, target.profileUserId!)).limit(1).for('update')
    if (!profile) throw notFound()
    if (profile.hiddenAt) throw conflict('target_not_public')
  }

  const [action] = await tx
    .insert(moderationActions)
    .values({
      kind: input.kind,
      outcome: input.outcome,
      targetType: target.targetType,
      targetKey: target.targetKey,
      publicationId: target.publicationId,
      releaseId: target.releaseId,
      itemKind: target.itemKind,
      itemKey: target.itemKey,
      seniorNoteId: target.seniorNoteId,
      caseStudyId: target.caseStudyId,
      profileUserId: target.profileUserId,
      communitySpaceId: target.communitySpaceId,
      communityPostId: target.communityPostId,
      communityCommentId: target.communityCommentId,
      internalNote: input.internalNote,
      publicReason: input.publicReason,
      notifyOwner: input.notifyOwner,
      createdBy: operatorId,
      createdAt: now,
    })
    .returning()

  switch (input.kind) {
    case 'none':
      // 신고 누적 임시 숨김(C-06)은 조치 없이 닫으면(기각·조치 없음) 다시 보입니다.
      if (target.communityPostId || target.communityCommentId) {
        await restoreAutoHiddenInTx(tx, { postId: target.communityPostId, commentId: target.communityCommentId }, now)
      }
      return action!
    case 'restrict':
      await restrictInTx(tx, publication!, now)
      break
    case 'hide_item':
      await tx.insert(releaseHiddenItems).values({
        publicationId: publication!.id,
        releaseId: target.releaseId!,
        itemKind: target.itemKind!,
        itemKey: target.itemKey!,
        actionId: action!.id,
        createdAt: now,
      })
      // 제공하는 내용이 바뀌었으므로 파일 ETag·캐시 키를 바꿉니다.
      await tx.update(publications).set({ accessEpoch: publication!.accessEpoch + 1, updatedAt: now }).where(eq(publications.id, publication!.id))
      break
    case 'hide_note':
      await tx.update(seniorNotes).set({ status: 'hidden', updatedAt: now }).where(eq(seniorNotes.id, target.seniorNoteId!))
      break
    case 'hide_case_study':
      await tx.update(caseStudies).set({ hiddenAt: now, updatedAt: now }).where(eq(caseStudies.id, target.caseStudyId!))
      break
    case 'hide_profile':
      await tx.update(profiles).set({ hiddenAt: now, updatedAt: now }).where(eq(profiles.userId, target.profileUserId!))
      break
    case 'restrict_space':
      await restrictSpaceInTx(tx, target.communitySpaceId!, now)
      break
    case 'hide_post':
      await hideCommunityItemInTx(tx, 'post', target.communityPostId!, now)
      break
    case 'hide_comment':
      await hideCommunityItemInTx(tx, 'comment', target.communityCommentId!, now)
      break
  }
  await emit(tx, action!.id, 'applied', now)
  await recordAudit(tx, {
    actorId: operatorId,
    action: 'moderation.apply',
    ...auditTarget(action!),
    projectId,
    metadata: { actionId: action!.id, kind: input.kind, itemKind: target.itemKind, notifyOwner: input.notifyOwner },
  })
  return action!
}

/**
 * 조치를 되돌립니다(운영자의 제한 해제 `lift` 또는 이의제기 되돌림 `appeal`). 이미 되돌렸으면 아무것도 하지 않고 false.
 * 대상이 그 사이 다른 상태가 되었으면(예: 제한 해제 뒤) 효과는 건너뛰고 조치만 되돌림으로 기록합니다.
 */
export async function undoModeration(
  tx: DbExecutor,
  actionId: string,
  operatorId: string,
  note: string,
  cause: 'lift' | 'appeal',
  now: Date,
): Promise<boolean> {
  const [action] = await tx.select().from(moderationActions).where(eq(moderationActions.id, actionId)).limit(1).for('update')
  if (!action) throw notFound()
  if (action.reversedAt) return false
  if (action.kind === 'none') throw conflict('not_reversible')
  let projectId: string | null = null
  switch (action.kind) {
    case 'restrict': {
      const publication = await lockPublication(tx, action.publicationId!)
      projectId = publication.projectId
      if (publication.status === 'restricted') await liftRestrictionInTx(tx, publication, now)
      break
    }
    case 'hide_item': {
      const publication = await lockPublication(tx, action.publicationId!)
      projectId = publication.projectId
      await tx.update(releaseHiddenItems).set({ liftedAt: now }).where(and(eq(releaseHiddenItems.actionId, action.id), isNull(releaseHiddenItems.liftedAt)))
      await tx.update(publications).set({ accessEpoch: publication.accessEpoch + 1, updatedAt: now }).where(eq(publications.id, publication.id))
      break
    }
    case 'hide_note':
      await tx
        .update(seniorNotes)
        .set({ status: 'published', updatedAt: now })
        .where(and(eq(seniorNotes.id, action.seniorNoteId!), eq(seniorNotes.status, 'hidden')))
      break
    case 'hide_case_study':
      await tx.update(caseStudies).set({ hiddenAt: null, updatedAt: now }).where(eq(caseStudies.id, action.caseStudyId!))
      break
    case 'hide_profile':
      await tx.update(profiles).set({ hiddenAt: null, updatedAt: now }).where(eq(profiles.userId, action.profileUserId!))
      break
    case 'restrict_space':
      await liftSpaceRestrictionInTx(tx, action.communitySpaceId!, now)
      break
    case 'hide_post':
      await unhideCommunityItemInTx(tx, 'post', action.communityPostId!, now, action.id)
      break
    case 'hide_comment':
      await unhideCommunityItemInTx(tx, 'comment', action.communityCommentId!, now, action.id)
      break
    case 'space_hide':
      if (action.communityPostId) await unhideCommunityItemInTx(tx, 'post', action.communityPostId, now, action.id)
      else await unhideCommunityItemInTx(tx, 'comment', action.communityCommentId!, now, action.id)
      break
    case 'sanction':
      await revokeSanctionByActionInTx(tx, action.id, operatorId, now)
      break
  }
  await tx
    .update(moderationActions)
    .set({ reversedAt: now, reversedBy: operatorId, reverseNote: note, reverseCause: cause })
    .where(eq(moderationActions.id, action.id))
  await emit(tx, action.id, 'reversed', now)
  await recordAudit(tx, {
    actorId: operatorId,
    action: cause === 'lift' ? 'moderation.lift' : 'moderation.reverse',
    ...auditTarget(action),
    projectId,
    metadata: { actionId: action.id, kind: action.kind },
  })
  return true
}
