import { decidePin } from '../../../modules/discord/capture'

/** POST /api/internal/discord/pin-decisions {requestId, discordUserId, decision} — 봇 전용(HMAC). 작성자의 승인·거절 버튼. */
export default defineInternalApiHandler((_event, body) => decidePin(requireDb(), body, primarySiteOrigin()))
