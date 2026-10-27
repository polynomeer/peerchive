import { listMyCommunityNotices } from '../../../../modules/community/notices'

/** GET /api/v1/community/notices — 내 커뮤니티 알림(최근 50개)과 읽지 않은 수(C-03). */
export default defineApiHandler((event) => listMyCommunityNotices(requireDb(), requireActor(event)))
