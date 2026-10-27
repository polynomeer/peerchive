import { markStudentCouncilRequest } from '../../../../../../modules/community/official'

/** POST /api/v1/operator/community/official-requests/:id/student-council — 학생회 요청으로 표시(기준 도달, 운영자 알림). */
export default defineApiHandler(async (event) => markStudentCouncilRequest(requireDb(), requireActor(event), getRouterParam(event, 'id')))
