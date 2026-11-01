import { redeemInviteCode } from '../../../../modules/institutions/institutions'

/**
 * POST /api/v1/me/affiliations/invite-code {code, standing} — 기관 초대 코드로 인증(I-01, ADR 0037). 201 + active 소속.
 * 410 invite_code_revoked·invite_code_expired·invite_code_exhausted, 422 invite_code_invalid, 429. 플래그가 꺼져 있으면 404.
 */
export default defineApiHandler(async (event) => {
  const result = await redeemInviteCode(requireDb(), requireActor(event), await readJsonBody(event), { ip: requestIp(event) })
  setResponseStatus(event, 201)
  return result
})
