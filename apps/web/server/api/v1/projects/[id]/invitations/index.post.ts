import { createInvitation } from '../../../../../modules/projects/invitations'

/**
 * POST /api/v1/projects/:id/invitations {role} — owner만.
 * 초대 URL(원문 토큰 포함)은 이 응답에서 한 번만 돌려주며 다시 조회할 수 없습니다.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const { invitation, token } = await createInvitation(
    requireDb(),
    actor,
    getRouterParam(event, 'id'),
    await readJsonBody(event),
  )
  setResponseStatus(event, 201)
  return { invitation, inviteUrl: `${primarySiteOrigin()}/invite/${token}` }
})
