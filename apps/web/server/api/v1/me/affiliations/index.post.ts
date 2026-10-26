import { requestAffiliation } from '../../../../modules/affiliation/affiliations'

/**
 * POST /api/v1/me/affiliations {schoolId, email, standing, departmentLabel?} — 학교 메일로 인증 코드 보내기(C-01, ADR 0018).
 * 202 + pending 소속. 그 주소가 이미 다른 계정에서 쓰이는지와 무관하게 같은 202(열거 방지). 404(없는 학교), 409 already_verified,
 * 422(email invalid_format·domain_not_allowed, departmentLabel), 429.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await requestAffiliation(requireDb(), actor, await readJsonBody(event), { ip: requestIp(event), mail: useMailTransport() })
  setResponseStatus(event, 202)
  return result
})
