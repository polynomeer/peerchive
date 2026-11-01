import { listMyHubNotices } from '../../../../modules/course-registrations/hub-opening'

/** GET /api/v1/me/course-hub-notices — 홈의 과목 허브 알림(열림·선배 노트 요청, E-02). 본인 것만. 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => listMyHubNotices(requireDb(), requireActor(event)))
