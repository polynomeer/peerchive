import { issueStaffInviteCode } from '../../../../../modules/institutions/institutions'

/**
 * POST /api/v1/institutions/:id/invite-codes {maxUses, expiresInDays?, cohortLabel?} — 그 기관 운영진·운영자(I-02). 201 + 원문 코드(이 응답에만).
 * 403 institution_staff_only, 플래그 꺼짐 404.
 */
export default defineApiHandler(async (event) => {
  const result = await issueStaffInviteCode(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
