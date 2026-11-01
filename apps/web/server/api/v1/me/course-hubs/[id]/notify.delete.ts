import { cancelHubOpenNotify } from '../../../../../modules/course-registrations/hub-opening'

/** DELETE /api/v1/me/course-hubs/:id/notify — 허브 열림 알림 신청 취소(E-02). */
export default defineApiHandler((event) => cancelHubOpenNotify(requireDb(), requireActor(event), getRouterParam(event, 'id')))
