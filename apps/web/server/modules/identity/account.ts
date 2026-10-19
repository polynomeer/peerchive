/**
 * 탈퇴 요청. 요청 즉시 users.status를 'deleted'로 바꾸고 deletion_requested_at을 기록한 뒤
 * 모든 세션을 지웁니다. 이후 로그인·공개 프로필 조회가 막힙니다.
 *
 * 실제 삭제(purge)와 DeletionLedger, 공동 기록·소유 프로젝트 처리(§6.6)는 범위 밖입니다(TODO).
 */
import { and, eq, ne, users, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import type { Actor } from '../errors'
import { invalidateUserSessions } from './sessions'

export async function requestAccountDeletion(db: DbExecutor, actor: Actor, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ status: 'deleted', deletionRequestedAt: now, updatedAt: now })
      .where(and(eq(users.id, actor.userId), ne(users.status, 'deleted')))
      .returning({ id: users.id })
    await invalidateUserSessions(tx, actor.userId)
    if (updated.length > 0) {
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'account.deletion_request',
        targetType: 'user',
        targetId: actor.userId,
      })
    }
  })
}
