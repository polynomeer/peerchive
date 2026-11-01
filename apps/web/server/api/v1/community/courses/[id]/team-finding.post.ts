import { setCourseTeamFindingAsCurator } from '../../../../../modules/community/recruitments'

/**
 * POST /api/v1/community/courses/:id/team-finding {disabled} — 그 과목 학생 큐레이터 또는 운영자(E-03, C-07 자리). 200 {courseId, teamFindingDisabled}.
 * 403 curator_only, 404, 422. 커뮤니티 모듈 경계(C-05) 안에 두려고 커뮤니티 경로에 둡니다(큐레이터 화면이 부름).
 */
export default defineApiHandler(async (event) => setCourseTeamFindingAsCurator(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
