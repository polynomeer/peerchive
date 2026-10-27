import { cancelRecruitment } from '../../../../../modules/community/recruitments'

/** POST /api/v1/community/recruitments/:id/cancel — 모집자만, 모집 중. 지원자에게 "모집이 취소되었습니다" 알림. 200, 403 recruiter_only, 404, 409 recruitment_not_open. */
export default defineApiHandler(async (event) => cancelRecruitment(requireDb(), requireActor(event), getRouterParam(event, 'id')))
