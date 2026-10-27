import { issueRecruitmentInvitation } from '../../../../../modules/community/recruitments'

/**
 * POST /api/v1/community/recruitments/:id/invitation — 마감된 모집에서 선정된 지원자 본인이 초대 링크를 받습니다(7일·한 번만, 이전 링크 취소).
 * 초대 URL(원문 토큰)은 이 응답에서 한 번만 돌려줍니다. 수락은 초대 화면에서 본인이 합니다. 200 {kind, inviteUrl}.
 * 404, 409 not_selected·not_closed·already_member·invitation_unavailable, 429.
 */
export default defineApiHandler(async (event) => {
  const { kind, token } = await issueRecruitmentInvitation(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  const path = kind === 'project' ? `/invite/${token}` : `/community/invite/${token}`
  return { kind, inviteUrl: `${primarySiteOrigin()}${path}` }
})
