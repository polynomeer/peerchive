import { MEETING_SUMMARY_MAX_BODY_BYTES } from '@peerchive/bot-protocol'
import { summarizeMeeting } from '../../../../modules/ai/meeting-summary'

/**
 * POST /api/internal/discord/meeting-summaries — 봇 전용(HMAC). `/summarize`: 최근 메시지(메모리에서만 다룸)를 AI로 회의 로그 초안으로 만듭니다.
 * 메시지 최대 200개·본문 40,000자라 이 경로만 본문 상한이 256KB입니다(나눠 보내면 서버가 원문 조각을 모아 두어야 해서 쓰지 않음, ADR 0058).
 */
export default defineInternalApiHandler((_event, body) => summarizeMeeting(requireDb(), body, primarySiteOrigin()), {
  maxBodyBytes: MEETING_SUMMARY_MAX_BODY_BYTES,
})
