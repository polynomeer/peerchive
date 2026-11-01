import { approveCohortMember } from '../../../../modules/institutions/cohort-approvals'

/**
 * POST /api/v1/affiliations/:id/cohort-approvals — 같은 기수의 비승인 수단 인증 멤버가 승인(I-01). 201.
 * 404(없음·자격 없음), 422 self_approval, 409 already_approved·not_pending. 플래그가 꺼져 있으면 404.
 */
export default defineApiHandler(async (event) => {
  const result = await approveCohortMember(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 201)
  return result
})
