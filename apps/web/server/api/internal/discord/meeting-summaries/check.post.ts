import { checkMeetingSummary } from '../../../../modules/ai/meeting-summary'

/** POST /api/internal/discord/meeting-summaries/check — 봇 전용(HMAC). `/summarize` 전에 메시지를 읽어도 되는지(AI 설정·연결·권한·팀 전원 동의) 확인. */
export default defineInternalApiHandler((_event, body) => checkMeetingSummary(requireDb(), body, primarySiteOrigin()))
