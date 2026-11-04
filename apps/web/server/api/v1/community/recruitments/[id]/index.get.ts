import { getRecruitmentView } from '../../../../../modules/community/recruitments'

/** GET /api/v1/community/recruitments/:id — 모집 상세(모집자에게는 지원 수·결과 링크). 과목을 등록하지 않은 인증 사용자는 `{registrationRequired: true}`만(ADR 0060 D-05). 200, 404. */
export default defineApiHandler(async (event) => getRecruitmentView(requireDb(), requireActor(event), getRouterParam(event, 'id')))
