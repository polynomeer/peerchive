import { createProject } from '../../../modules/projects/projects'
import { createProjectFromRegistration } from '../../../modules/course-registrations/registrations'

/**
 * POST /api/v1/projects — 생성자가 owner가 됩니다. 항상 비공개.
 * `courseRegistrationId`(E-01)를 주면 내 과목 등록의 개설 학기로 만들어 과목·학기·엠바고가 채워집니다(`courseTermId`와 함께 보내면 422).
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const body = await readJsonBody(event)
  const fromRegistration = typeof body === 'object' && body !== null && (body as Record<string, unknown>).courseRegistrationId != null
  const project = fromRegistration ? await createProjectFromRegistration(requireDb(), actor, body) : await createProject(requireDb(), actor, body)
  setResponseStatus(event, 201)
  return project
})
