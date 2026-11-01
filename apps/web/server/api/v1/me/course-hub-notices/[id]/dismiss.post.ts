import { dismissHubOpenedNotice } from '../../../../../modules/course-registrations/hub-opening'

/** POST /api/v1/me/course-hub-notices/:id/dismiss — 허브 열림 알림 닫기(E-02, 멱등). 아직 열리지 않았으면 409 `not_opened`. */
export default defineApiHandler((event) => dismissHubOpenedNotice(requireDb(), requireActor(event), getRouterParam(event, 'id')))
