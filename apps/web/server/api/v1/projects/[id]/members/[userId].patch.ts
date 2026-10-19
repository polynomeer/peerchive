import { changeMemberRole } from '../../../../../modules/projects/members'

/** PATCH /api/v1/projects/:id/members/:userId {role} — owner만, owner 지정 불가. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return changeMemberRole(
    requireDb(),
    actor,
    getRouterParam(event, 'id'),
    getRouterParam(event, 'userId'),
    await readJsonBody(event),
  )
})
