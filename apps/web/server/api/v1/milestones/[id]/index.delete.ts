import { deleteMilestone } from '../../../../modules/milestones/milestones'

/** DELETE /api/v1/milestones/:id — owner/editor. 로그가 가리키면(이전 revision 포함) 409 in_use. 204. */
export default defineApiHandler(async (event) => {
  await deleteMilestone(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
