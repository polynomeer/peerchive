import { updateProject } from '../../../../modules/projects/projects'

/** PATCH /api/v1/projects/:id {expectedVersion, ...} — owner/editor. version 불일치는 409. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return updateProject(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
