import { getMyHubOpening } from '../../../../../modules/course-registrations/hub-opening'

/** GET /api/v1/me/course-hubs/:id/opening — 준비 중 허브에서 본인 상태(등록·마침·알림 신청·내 노트, E-02). 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => getMyHubOpening(requireDb(), requireActor(event), getRouterParam(event, 'id')))
