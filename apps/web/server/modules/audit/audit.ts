/**
 * 감사 이벤트 기록(§6.6 AuditEvent 최소형). 본문·토큰·메일 주소는 넣지 않습니다.
 * 같은 트랜잭션 안에서 호출해 업무 변경과 감사 기록이 함께 커밋되게 합니다.
 */
import { auditEvents, type DbExecutor } from '@peerchive/db'

export type AuditAction =
  | 'project.create'
  | 'invitation.create'
  | 'invitation.revoke'
  | 'invitation.accept'
  | 'member.role_change'
  | 'member.remove'
  | 'member.leave'
  | 'project.transfer_ownership'
  | 'account.deletion_request'
  | 'log.create'
  | 'log.revise'
  | 'artifact.upload'
  | 'artifact.rescan'
  | 'milestone.create'
  | 'milestone.update'
  | 'milestone.delete'
  | 'milestone.reorder'
  | 'milestone.apply_template'
  | 'milestone.snapshot_add'
  | 'milestone.snapshot_remove'
  | 'project.retro_mode'
  | 'task.create'
  | 'task.update'
  | 'task.reorder'
  | 'task.complete'
  | 'task.convert'
  | 'task.delete'
  | 'claim.create'
  | 'claim.revise'
  | 'endorsement.set'
  | 'endorsement.withdraw'
  | 'integration.link'
  | 'integration.unlink'
  | 'discord.bind'
  | 'discord.unbind'
  | 'discord.binding_update'
  | 'discord.pin_request'
  | 'discord.pin_decision'
  | 'checkin.submit'
  | 'school.create'
  | 'school.merge'
  | 'course.create'
  | 'course.merge'
  | 'course_term.create'
  | 'course_term.adjust_ends_at'
  | 'concept_tag.create'
  | 'concept_tag.attach'
  | 'concept_tag.merge'
  | 'project.course_term'
  | 'embargo.create'
  | 'embargo.lower'
  | 'operator.grant'
  | 'operator.revoke'
  | 'publication.candidate_create'
  | 'publication.exclude_declined'
  | 'consent.decide'

export async function recordAudit(
  db: DbExecutor,
  event: {
    actorId: string | null
    action: AuditAction
    targetType:
      | 'project'
      | 'invitation'
      | 'member'
      | 'user'
      | 'log'
      | 'artifact'
      | 'milestone'
      | 'task'
      | 'claim'
      | 'integration'
      | 'discord_binding'
      | 'discord_pin_request'
      | 'checkin'
      | 'school'
      | 'course'
      | 'course_term'
      | 'concept_tag'
      | 'embargo'
      | 'operator'
      | 'publication_candidate'
      | 'consent'
    targetId?: string | null
    projectId?: string | null
    metadata?: Record<string, string | number | boolean | null>
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    projectId: event.projectId ?? null,
    metadata: event.metadata ?? {},
  })
}
