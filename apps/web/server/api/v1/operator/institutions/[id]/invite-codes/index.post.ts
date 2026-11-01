import { issueInviteCode } from '../../../../../../modules/institutions/institutions'

/**
 * POST /api/v1/operator/institutions/:id/invite-codes {maxUses, expiresInDays?, cohortLabel?} — 운영자만(I-01). 201 + 원문 코드(이 응답에만).
 * 플래그가 꺼져 있으면 404.
 */
export default defineApiHandler(async (event) => {
  const result = await issueInviteCode(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
