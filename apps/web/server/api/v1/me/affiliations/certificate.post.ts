import { requestCertificateCheck } from '../../../../modules/institutions/certificates'

/**
 * POST /api/v1/me/affiliations/certificate {institutionId, standing, cohortLabel?, declaredType, fileName, byteSize} — 수료증 확인 요청(I-01).
 * 201 + pending 소속 + uploadUrl(PUT). 플래그가 꺼져 있으면 404.
 */
export default defineApiHandler(async (event) => {
  const result = await requestCertificateCheck(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
