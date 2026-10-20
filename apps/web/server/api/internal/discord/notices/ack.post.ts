import { ackNotice } from '../../../../modules/discord/notices'

/** POST /api/internal/discord/notices/ack {id, delivered, discordMessageId?} — 봇 전용(HMAC). */
export default defineInternalApiHandler((_event, body) => ackNotice(requireDb(), body))
