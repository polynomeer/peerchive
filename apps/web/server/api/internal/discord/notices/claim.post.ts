import { claimNotices } from '../../../../modules/discord/notices'

/** POST /api/internal/discord/notices/claim — 봇 전용(HMAC). 지금 보낼 체크인 알림·주간 요약(5분 임대). */
export default defineInternalApiHandler(() => claimNotices(requireDb(), primarySiteOrigin()))
