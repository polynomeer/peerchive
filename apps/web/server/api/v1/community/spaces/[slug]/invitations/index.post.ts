import { createSpaceInvitation } from '../../../../../../modules/community/invitations'

/**
 * POST /api/v1/community/spaces/:slug/invitations — 초대 링크 만들기(owner·admin, 7일·한 번만). 201.
 * 초대 URL(원문 토큰 포함)은 이 응답에서 한 번만 돌려주며 다시 조회할 수 없습니다.
 */
export default defineApiHandler(async (event) => {
  const { invitation, token } = await createSpaceInvitation(requireDb(), requireActor(event), getRouterParam(event, 'slug'))
  setResponseStatus(event, 201)
  return { invitation, inviteUrl: `${primarySiteOrigin()}/community/invite/${token}` }
})
