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

export async function recordAudit(
  db: DbExecutor,
  event: {
    actorId: string | null
    action: AuditAction
    targetType: 'project' | 'invitation' | 'member' | 'user'
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
