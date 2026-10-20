import { bindChannel } from '../../../modules/discord/bindings'

/** POST /api/internal/discord/bind {discordUserId, guildId, channelId, code, label?} — 봇 전용(HMAC). `/peerchive bind <코드>`. */
export default defineInternalApiHandler((_event, body) => bindChannel(requireDb(), body, primarySiteOrigin()))
