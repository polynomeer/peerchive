import { listMyCourseRegistrations } from '../../../../modules/course-registrations/registrations'

/** GET /api/v1/me/course-registrations — 내 이번 학기 과목 등록과 등록할 수 있는 학기(E-01). 본인만. */
export default defineApiHandler((event) => listMyCourseRegistrations(requireDb(), requireActor(event)))
