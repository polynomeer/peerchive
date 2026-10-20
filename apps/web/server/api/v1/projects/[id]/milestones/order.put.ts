import { reorderMilestones } from '../../../../../modules/milestones/milestones'

/** PUT /api/v1/projects/:id/milestones/order {milestoneIds[]} — owner/editor. 전체 순열이 아니면 422. 새 목록을 돌려줍니다. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return reorderMilestones(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
