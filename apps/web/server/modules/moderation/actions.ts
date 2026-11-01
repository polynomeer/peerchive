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
 * | hide_recruitment·hide_application(C-07) | 모집 글 hidden_at(모집자 외 404·지원 받지 않음) / 지원 메시지 message_hidden_at(모집자에게 자리 표시) | 가림을 풂 |
 * | hide_qa(C-09) | 막힘 Q&A published → hidden | hidden → published(당사자가 그사이 철회했으면 그대로 withdrawn) |
 * | hide_retro(A-06) | 수료 회고 published → hidden | hidden → published(작성자가 그사이 철회했으면 그대로 withdrawn) |
 * | hide_persona(S-07) | 그 페르소나의 profiles.hidden_at(실명·표시명 하나만 — 같은 사람의 다른 페르소나는 그대로) | hidden_at = null |
 * | hide_profile_post(S-07) | 프로필 글 published → hidden(활동은 같은 트랜잭션의 DB 트리거가 거둠) | hidden → published(트리거가 원천을 다시 확인해 되살림) |
 * | hide_social_link(S-07) | social_links.hidden_at(공개 DTO에서 빠짐) | hidden_at = null |
 * | hide_room_item(A-07) | 방 항목(명부 항목·일정·투표·앨범 사진·방별 프로필) 하나의 hidden_at(방 멤버 화면·서명 URL에서 빠짐) | hidden_at = null(행이 지워졌으면 그대로) |
 * | hide_stuck_qa_post(E-04) | 막힘 Q&A 글 published → hidden(질문이면 스레드 전체가 안 보임) | hidden → published(작성자가 그사이 지웠으면 그대로) |
 *
 * 공개 읽기는 이 상태를 요청마다 읽으므로 커밋 즉시 효력이 있습니다(worker 무관). outbox `moderation.action`은 worker가 검색 문서 같은 남은 사본을
 * 맞추는 데만 씁니다. 삭제 조치는 없습니다(차단 ≠ 삭제).
 */
import { type ModerationActionKind, transition } from '@peerchive/domain'
import {
  MODERATION_ACTION_TOPIC,
  and,
  caseStudies,
  completionRetros,
  courseQaItems,
  eq,
  isNull,
  moderationActions,
  outboxEvents,
  profilePosts,
  profiles,
  publicationCandidates,
  publications,
  releaseHiddenItems,
  seniorNotes,
  socialLinks,
  type DbExecutor,
  type ModerationActionOutboxPayload,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { liftSpaceRestrictionInTx, restrictSpaceInTx } from '../community/official'
import {
  hideCommunityItemInTx,
  hideRecruitmentItemInTx,
  hideRoomItemInTx,
  restoreAutoHiddenInTx,
  revokeSanctionByActionInTx,
  unhideCommunityItemInTx,
  unhideRecruitmentItemInTx,
  unhideRoomItemInTx,
} from '../community/reporting'
import { conflict, notFound } from '../errors'
import { hideStuckQaPostInTx, unhideStuckQaPostInTx } from '../course-hub/stuck-qa'
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
  action: Pick<
    ActionRow,
    | 'targetType'
    | 'publicationId'
    | 'seniorNoteId'
    | 'caseStudyId'
    | 'profileUserId'
    | 'communitySpaceId'
    | 'communityPostId'
    | 'communityCommentId'
    | 'communityRecruitmentId'
    | 'communityApplicationId'
    | 'courseQaItemId'
    | 'personaId'
    | 'profilePostId'
    | 'socialLinkId'
    | 'completionRetroId'
    | 'roomItemId'
    | 'stuckQaPostId'
  >,
) {
  switch (action.targetType) {
    case 'community_space':
      return { targetType: 'community_space' as const, targetId: action.communitySpaceId }
    case 'community_post':
      return { targetType: 'community_post' as const, targetId: action.communityPostId }
    case 'community_comment':
      return { targetType: 'community_comment' as const, targetId: action.communityCommentId }
    case 'community_recruitment':
      return { targetType: 'community_recruitment' as const, targetId: action.communityRecruitmentId }
    case 'community_application':
      return { targetType: 'community_application' as const, targetId: action.communityApplicationId }
    case 'publication':
    case 'publication_item':
      return { targetType: 'publication' as const, targetId: action.publicationId }
    case 'senior_note':
      return { targetType: 'senior_note' as const, targetId: action.seniorNoteId }
    case 'case_study':
      return { targetType: 'case_study' as const, targetId: action.caseStudyId }
    case 'profile':
      return { targetType: 'user' as const, targetId: action.profileUserId }
    case 'course_qa':
      return { targetType: 'course_qa' as const, targetId: action.courseQaItemId }
    // S-07: 대상 하나(페르소나·글·링크). metadata에는 조치 id·종류만이고 handle·주인 사용자는 없습니다.
    case 'persona':
      return { targetType: 'persona' as const, targetId: action.personaId }
    case 'profile_post':
      return { targetType: 'profile_post' as const, targetId: action.profilePostId }
    case 'social_link':
      return { targetType: 'social_link' as const, targetId: action.socialLinkId }
    case 'completion_retro':
      return { targetType: 'completion_retro' as const, targetId: action.completionRetroId }
    // A-07: 항목 id만(종류는 metadata의 itemKind). 주인 사용자는 없습니다.
    case 'room_item':
      return { targetType: 'room_item' as const, targetId: action.roomItemId }
    // E-04: 글 id만(작성자·번호 없음).
    case 'stuck_qa_post':
      return { targetType: 'stuck_qa_post' as const, targetId: action.stuckQaPostId }
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
  if (input.kind === 'hide_qa') {
    if (!target.courseQaItemId) throw notFound()
    const [qa] = await tx.select().from(courseQaItems).where(eq(courseQaItems.id, target.courseQaItemId)).limit(1).for('update')
    if (!qa) throw notFound()
    if (qa.status !== 'published') throw conflict('target_not_public')
  }
  if (input.kind === 'hide_retro') {
    if (!target.completionRetroId) throw notFound()
    const [retro] = await tx.select({ status: completionRetros.status }).from(completionRetros).where(eq(completionRetros.id, target.completionRetroId)).limit(1).for('update')
    if (!retro) throw notFound()
    if (retro.status !== 'published') throw conflict('target_not_public')
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
  if (input.kind === 'hide_recruitment' && !target.communityRecruitmentId) throw notFound()
  // A-07: 행 잠금·상태 확인은 조치 행을 만든 뒤 hideRoomItemInTx가 합니다(없음 404, 이미 숨김 409 — 같은 트랜잭션이라 함께 되돌아감).
  if (input.kind === 'hide_room_item' && (!target.roomItemKind || !target.roomItemId)) throw notFound()
  if (input.kind === 'hide_application' && !target.communityApplicationId) throw notFound()
  // E-04: 행 잠금·상태 확인은 조치 행을 만든 뒤 hideStuckQaPostInTx가 합니다(같은 트랜잭션).
  if (input.kind === 'hide_stuck_qa_post' && !target.stuckQaPostId) throw notFound()
  if (input.kind === 'hide_profile') {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, target.profileUserId!)).limit(1).for('update')
    if (!profile) throw notFound()
    if (profile.hiddenAt) throw conflict('target_not_public')
  }
  // S-07: 그 페르소나·글·링크 하나만 잠그고 확인합니다.
  if (input.kind === 'hide_persona') {
    if (!target.personaId) throw notFound()
    const [profile] = await tx.select().from(profiles).where(eq(profiles.personaId, target.personaId)).limit(1).for('update')
    if (!profile) throw notFound()
    if (profile.hiddenAt) throw conflict('target_not_public')
  }
  if (input.kind === 'hide_profile_post') {
    if (!target.profilePostId) throw notFound()
    const [post] = await tx.select({ status: profilePosts.status }).from(profilePosts).where(eq(profilePosts.id, target.profilePostId)).limit(1).for('update')
    if (!post) throw notFound()
    if (post.status !== 'published') throw conflict('target_not_public')
  }
  if (input.kind === 'hide_social_link') {
    if (!target.socialLinkId) throw notFound()
    const [link] = await tx.select({ hiddenAt: socialLinks.hiddenAt }).from(socialLinks).where(eq(socialLinks.id, target.socialLinkId)).limit(1).for('update')
    if (!link) throw notFound()
    if (link.hiddenAt) throw conflict('target_not_public')
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
      communityRecruitmentId: target.communityRecruitmentId,
      communityApplicationId: target.communityApplicationId,
      courseQaItemId: target.courseQaItemId,
      personaId: target.personaId,
      profilePostId: target.profilePostId,
      socialLinkId: target.socialLinkId,
      completionRetroId: target.completionRetroId,
      roomItemKind: target.roomItemKind,
      roomItemId: target.roomItemId,
      stuckQaPostId: target.stuckQaPostId,
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
    case 'hide_qa':
      await tx.update(courseQaItems).set({ status: 'hidden', updatedAt: now }).where(eq(courseQaItems.id, target.courseQaItemId!))
      break
    case 'hide_note':
      await tx.update(seniorNotes).set({ status: 'hidden', updatedAt: now }).where(eq(seniorNotes.id, target.seniorNoteId!))
      break
    case 'hide_retro':
      await tx.update(completionRetros).set({ status: 'hidden', updatedAt: now }).where(eq(completionRetros.id, target.completionRetroId!))
      break
    case 'hide_case_study':
      await tx.update(caseStudies).set({ hiddenAt: now, updatedAt: now }).where(eq(caseStudies.id, target.caseStudyId!))
      break
    case 'hide_profile':
      await tx.update(profiles).set({ hiddenAt: now, updatedAt: now }).where(eq(profiles.userId, target.profileUserId!))
      break
    case 'hide_persona':
      await tx.update(profiles).set({ hiddenAt: now, updatedAt: now }).where(eq(profiles.personaId, target.personaId!))
      break
    case 'hide_profile_post':
      // 상태 변경과 같은 트랜잭션에서 DB 트리거(profile_posts_persona_activity_sync)가 활동을 거둡니다(활동 목록·피드에서 다음 요청부터 빠짐).
      await tx.update(profilePosts).set({ status: 'hidden' }).where(eq(profilePosts.id, target.profilePostId!))
      break
    case 'hide_social_link':
      await tx.update(socialLinks).set({ hiddenAt: now }).where(eq(socialLinks.id, target.socialLinkId!))
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
    case 'hide_recruitment':
      await hideRecruitmentItemInTx(tx, 'recruitment', target.communityRecruitmentId!, now)
      break
    case 'hide_application':
      await hideRecruitmentItemInTx(tx, 'application', target.communityApplicationId!, now)
      break
    case 'hide_room_item':
      await hideRoomItemInTx(tx, target.roomItemKind!, target.roomItemId!, now)
      break
    case 'hide_stuck_qa_post':
      await hideStuckQaPostInTx(tx, target.stuckQaPostId!, now)
      break
  }
  await emit(tx, action!.id, 'applied', now)
  await recordAudit(tx, {
    actorId: operatorId,
    action: 'moderation.apply',
    ...auditTarget(action!),
    projectId,
    metadata: { actionId: action!.id, kind: input.kind, itemKind: target.itemKind ?? target.roomItemKind, notifyOwner: input.notifyOwner },
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
    case 'hide_qa':
      await tx
        .update(courseQaItems)
        .set({ status: 'published', updatedAt: now })
        .where(and(eq(courseQaItems.id, action.courseQaItemId!), eq(courseQaItems.status, 'hidden')))
      break
    // A-06: 그사이 작성자가 철회했거나 탈퇴 정리됐으면 그대로 둡니다.
    case 'hide_retro':
      await tx
        .update(completionRetros)
        .set({ status: 'published', updatedAt: now })
        .where(and(eq(completionRetros.id, action.completionRetroId!), eq(completionRetros.status, 'hidden')))
      break
    case 'hide_case_study':
      await tx.update(caseStudies).set({ hiddenAt: null, updatedAt: now }).where(eq(caseStudies.id, action.caseStudyId!))
      break
    case 'hide_profile':
      await tx.update(profiles).set({ hiddenAt: null, updatedAt: now }).where(eq(profiles.userId, action.profileUserId!))
      break
    // S-07: 대상이 탈퇴 정리로 지워졌으면 바꿀 행이 없고 조치만 되돌림으로 남습니다.
    case 'hide_persona':
      await tx.update(profiles).set({ hiddenAt: null, updatedAt: now }).where(eq(profiles.personaId, action.personaId!))
      break
    case 'hide_profile_post':
      // hidden → published: 트리거가 원천을 다시 확인해 거둔 활동을 되살립니다.
      await tx
        .update(profilePosts)
        .set({ status: 'published' })
        .where(and(eq(profilePosts.id, action.profilePostId!), eq(profilePosts.status, 'hidden')))
      break
    case 'hide_social_link':
      await tx.update(socialLinks).set({ hiddenAt: null }).where(eq(socialLinks.id, action.socialLinkId!))
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
    case 'hide_recruitment':
      await unhideRecruitmentItemInTx(tx, 'recruitment', action.communityRecruitmentId!, now)
      break
    case 'hide_application':
      await unhideRecruitmentItemInTx(tx, 'application', action.communityApplicationId!, now)
      break
    case 'hide_room_item':
      await unhideRoomItemInTx(tx, action.roomItemKind!, action.roomItemId!)
      break
    case 'hide_stuck_qa_post':
      await unhideStuckQaPostInTx(tx, action.stuckQaPostId!, now)
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
