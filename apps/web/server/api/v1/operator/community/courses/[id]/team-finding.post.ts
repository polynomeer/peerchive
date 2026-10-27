import { setCourseTeamFinding } from '../../../../../../modules/community/recruitments'

/**
 * POST /api/v1/operator/community/courses/:id/team-finding {disabled} — 팀 배정 과목의 팀원 찾기 숨김(C-07, 과목 큐레이터 자리, 지금은 운영자만).
 * 200 {courseId, teamFindingDisabled}. 403 operator_only, 404, 422.
 */
export default defineApiHandler(async (event) => setCourseTeamFinding(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
