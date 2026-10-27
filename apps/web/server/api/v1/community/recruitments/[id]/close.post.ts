import { closeRecruitment } from '../../../../../modules/community/recruitments'

/**
 * POST /api/v1/community/recruitments/:id/close — 모집자만. 팀원 찾기는 비공개 과제 공간, 스터디는 초대 전용 스터디 방을 만들고 선정된 사람에게 초대 알림.
 * 200 상세. 403 recruiter_only·write_restricted, 404, 409 recruitment_not_open·no_accepted.
 */
export default defineApiHandler(async (event) => closeRecruitment(requireDb(), requireActor(event), getRouterParam(event, 'id')))
