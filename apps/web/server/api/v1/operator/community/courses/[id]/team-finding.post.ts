import { setCourseTeamFinding } from '../../../../../../modules/community/recruitments'

/**
 * POST /api/v1/operator/community/courses/:id/team-finding {disabled} — 팀 배정 과목의 팀원 찾기 숨김(C-07, 운영자 경로 — 학생 큐레이터는 /api/v1/community/courses/:id/team-finding, E-03).
 * 200 {courseId, teamFindingDisabled}. 403 operator_only, 404, 422.
 */
export default defineApiHandler(async (event) => setCourseTeamFinding(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
