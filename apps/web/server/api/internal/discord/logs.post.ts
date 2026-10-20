import { captureLog } from '../../../modules/discord/capture'

/** POST /api/internal/discord/logs — 봇 전용(HMAC). `/log`. interaction id로 한 번만 만듭니다. */
export default defineInternalApiHandler((_event, body) => captureLog(requireDb(), body, primarySiteOrigin()))
