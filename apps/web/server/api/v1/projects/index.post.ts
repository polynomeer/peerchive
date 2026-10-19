import { createProject } from '../../../modules/projects/projects'

/** POST /api/v1/projects — 생성자가 owner가 됩니다. 항상 비공개. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const project = await createProject(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, 201)
  return project
})
