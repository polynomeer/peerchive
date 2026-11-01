import { requestHubOpenNotify } from '../../../../../modules/course-registrations/hub-opening'

/** POST /api/v1/me/course-hubs/:id/notify — 허브가 열리면 홈에 알림(E-02, 등록한 학생만, 멱등). 403 `not_registered`, 409 `already_open`. */
export default defineApiHandler((event) => requestHubOpenNotify(requireDb(), requireActor(event), getRouterParam(event, 'id')))
