import { listOfficialRequestGroups } from '../../../../../modules/community/official'

/** GET /api/v1/operator/community/official-requests — 운영자만. 학교·학과별 요청 묶음(요청자 수·학생회·기준 도달). */
export default defineApiHandler(async (event) => listOfficialRequestGroups(requireDb(), requireActor(event)))
