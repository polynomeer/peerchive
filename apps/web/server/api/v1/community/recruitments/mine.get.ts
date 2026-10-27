import { listMyRecruitments } from '../../../../modules/community/recruitments'

/** GET /api/v1/community/recruitments/mine — 내가 올린 모집과 내 지원(상태만). 200. */
export default defineApiHandler(async (event) => listMyRecruitments(requireDb(), requireActor(event)))
