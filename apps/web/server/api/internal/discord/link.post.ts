import { linkDiscordAccount } from '../../../modules/discord/accounts'

/** POST /api/internal/discord/link {discordUserId, code} — 봇 전용(HMAC). `/peerchive link <코드>`. */
export default defineInternalApiHandler((_event, body) => linkDiscordAccount(requireDb(), body))
