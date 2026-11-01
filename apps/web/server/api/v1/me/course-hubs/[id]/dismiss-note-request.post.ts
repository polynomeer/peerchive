import { dismissHubNoteRequest } from '../../../../../modules/course-registrations/hub-opening'

/** POST /api/v1/me/course-hubs/:id/dismiss-note-request — 마친 과목의 선배 노트 요청 닫기(E-02, 멱등). */
export default defineApiHandler((event) => dismissHubNoteRequest(requireDb(), requireActor(event), getRouterParam(event, 'id')))
