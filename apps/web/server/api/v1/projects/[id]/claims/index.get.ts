import { listClaims } from '../../../../../modules/contribution/claims'

/** GET /api/v1/projects/:id/claims — 멤버(읽기 전용 포함). 모든 역할 선언(현재 revision·근거·확인·상태), 작성자 이름순. */
export default defineApiHandler((event) => listClaims(requireDb(), requireActor(event), getRouterParam(event, 'id')))
