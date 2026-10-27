import { listApplications } from '../../../../../../modules/community/recruitments'

/**
 * GET /api/v1/community/recruitments/:id/applications — **모집자만**(모더레이터·운영자·다른 지원자는 403 recruiter_only, 읽을 수 없으면 404).
 * 지원 시각 순서만, 순위·활동량 필드 없음. 200 RecruitmentApplicationDto[].
 */
export default defineApiHandler(async (event) => listApplications(requireDb(), requireActor(event), getRouterParam(event, 'id')))
