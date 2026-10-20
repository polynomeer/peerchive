import { capturePin } from '../../../modules/discord/capture'

/** POST /api/internal/discord/pins — 봇 전용(HMAC). 📌 반응(본인 메시지는 바로 로그, 남의 메시지는 승인 요청). */
export default defineInternalApiHandler((_event, body) => capturePin(requireDb(), body, primarySiteOrigin()))
