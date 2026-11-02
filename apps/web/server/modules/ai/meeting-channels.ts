/**
 * 회의 채널 행 정리 (E-13, ADR 0058). 채널 연결 해제(discord/bindings.ts)·멤버 나가기·내보내기(projects/members.ts)가 부릅니다.
 * AI 설정과 무관하게 동작합니다(AI가 꺼져 있어도 남은 행을 지움). 이 파일은 DB 테이블만 알아 순환 import를 만들지 않습니다.
 */
import { aiMeetingChannels, aiMeetingConsents, aiMeetingDrafts, and, eq, inArray, type DbExecutor } from '@peerchive/db'

/** 채널 연결 하나의 회의 채널 제안·동의·승인 전 초안을 지웁니다(초안 → 동의 → 제안, 외래 키 순서). 지운 초안 수. */
export async function deleteMeetingChannelRows(db: DbExecutor, bindingId: string): Promise<number> {
  const [channel] = await db.select({ id: aiMeetingChannels.id }).from(aiMeetingChannels).where(eq(aiMeetingChannels.bindingId, bindingId)).limit(1)
  if (!channel) return 0
  const drafts = await db.delete(aiMeetingDrafts).where(eq(aiMeetingDrafts.meetingChannelId, channel.id)).returning({ id: aiMeetingDrafts.id })
  await db.delete(aiMeetingConsents).where(eq(aiMeetingConsents.meetingChannelId, channel.id))
  await db.delete(aiMeetingChannels).where(eq(aiMeetingChannels.id, channel.id))
  return drafts.length
}

/**
 * 과제를 떠난(나감·내보냄) 멤버의 그 과제 회의 채널 동의를 지웁니다. 다시 들어오면 새로 동의해야 합니다.
 * (요약 가능 여부는 지금 active 멤버로만 계산하므로 지우지 않아도 요약은 막히지 않지만, 예전 동의가 재가입 뒤에 되살아나지 않게 합니다.)
 */
export async function deleteMeetingConsentsOf(db: DbExecutor, projectId: string, userId: string): Promise<void> {
  const channels = await db.select({ id: aiMeetingChannels.id }).from(aiMeetingChannels).where(eq(aiMeetingChannels.projectId, projectId))
  if (channels.length === 0) return
  await db
    .delete(aiMeetingConsents)
    .where(and(eq(aiMeetingConsents.userId, userId), inArray(aiMeetingConsents.meetingChannelId, channels.map((c) => c.id))))
}
