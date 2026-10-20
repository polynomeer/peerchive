import { updateMilestone } from '../../../../modules/milestones/milestones'

/** PATCH /api/v1/milestones/:id {expectedVersion, title?, note?, dueAt?, claimedAt?} — owner/editor. 낡은 version은 409. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return updateMilestone(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
