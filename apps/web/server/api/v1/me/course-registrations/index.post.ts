import { registerCourse } from '../../../../modules/course-registrations/registrations'

/** POST /api/v1/me/course-registrations {courseId, year, semester} — 201. 카탈로그에 있는 과목·지금/다음 학기만(E-01). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const registration = await registerCourse(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, 201)
  return registration
})
