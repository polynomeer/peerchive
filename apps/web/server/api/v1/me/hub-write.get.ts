import { getHubWriteEligibility } from '../../../modules/course-hub/senior-notes'

/** GET /api/v1/me/hub-write?course=<id> — 이 과목 허브(선배 노트)에 쓸 수 있는지와 필요한 학교 인증(C-01). 404(없는 과목). */
export default defineApiHandler(async (event) => getHubWriteEligibility(requireDb(), requireActor(event), getQuery(event).course))
