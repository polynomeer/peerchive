import { removeCourseRegistration } from '../../../../modules/course-registrations/registrations'

/** DELETE /api/v1/me/course-registrations/:id — 내 과목 등록 지우기(E-01). 남의 것·없는 id 404. */
export default defineApiHandler((event) => removeCourseRegistration(requireDb(), requireActor(event), getRouterParam(event, 'id')))
