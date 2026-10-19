import { removeMember } from '../../../../../modules/projects/members'

/** DELETE /api/v1/projects/:id/members/:userId — owner가 멤버를 내보냅니다(status → removed). */
export default defineApiHandler(async (event) => {
  await removeMember(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'userId'))
  setResponseStatus(event, 204)
  return null
})
