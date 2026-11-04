/**
 * 과제를 떠난 멤버의 AI 회고 자료 정리(ADR 0060 D-10). 나가기·내보내기와 같은 트랜잭션에서 그 사람의 그 과제 세션·초안·켜기 행을 지웁니다.
 * 접근할 수 없게 된 사람의 답변·초안을 7일 보존 작업(`ai-retro-sessions`)까지 남겨 둘 이유가 없습니다. 다시 들어오면 새로 켭니다.
 * 이 파일은 멤버 모듈이 부르므로 회고 인터뷰 모듈(로그·공급자 의존)을 import하지 않습니다.
 */
import { aiRetroDrafts, aiRetroOptIns, aiRetroSessions, and, eq, type DbExecutor } from '@peerchive/db'

export async function deleteRetroDataOf(db: DbExecutor, projectId: string, userId: string): Promise<void> {
  await db.delete(aiRetroDrafts).where(and(eq(aiRetroDrafts.projectId, projectId), eq(aiRetroDrafts.userId, userId)))
  await db.delete(aiRetroSessions).where(and(eq(aiRetroSessions.projectId, projectId), eq(aiRetroSessions.userId, userId)))
  await db.delete(aiRetroOptIns).where(and(eq(aiRetroOptIns.projectId, projectId), eq(aiRetroOptIns.userId, userId)))
}
