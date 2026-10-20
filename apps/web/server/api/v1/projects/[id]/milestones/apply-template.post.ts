import { applyMilestoneTemplate } from '../../../../../modules/milestones/milestones'

/** POST /api/v1/projects/:id/milestones/apply-template — owner/editor, 마일스톤이 없을 때만(아니면 409 not_empty). 201 + 목록. */
export default defineApiHandler(async (event) => {
  const milestones = await applyMilestoneTemplate(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 201)
  return milestones
})
