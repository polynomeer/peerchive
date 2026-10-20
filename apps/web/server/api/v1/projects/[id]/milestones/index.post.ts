import { createMilestone } from '../../../../../modules/milestones/milestones'

/** POST /api/v1/projects/:id/milestones {title, note?, dueAt?, claimedAt?} — owner/editor. 201, 한도 초과는 409 limit_reached. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const milestone = await createMilestone(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return milestone
})
