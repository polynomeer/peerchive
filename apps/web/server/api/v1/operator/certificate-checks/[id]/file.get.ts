import { openCertificateFile } from '../../../../../modules/institutions/certificates'

/**
 * GET /api/v1/operator/certificate-checks/:id/file?exp=&sig= — 운영자 세션 + 맞는 서명(그 운영자·60초) + 결정 전일 때만 수료증 내용(I-01).
 * 그 밖은 모두 404. 산출물 내용과 같은 보호 헤더(nosniff·sandbox CSP·no-store), 이름은 고정(원래 파일 이름은 저장하지 않음).
 */
export default defineApiHandler(async (event) => {
  const query = getQuery(event)
  const content = await openCertificateFile(requireDb(), useObjectStorage(), requireActor(event), getRouterParam(event, 'id'), {
    exp: query.exp,
    sig: query.sig,
  })
  setResponseHeaders(event, {
    'content-type': content.mediaType,
    'content-length': content.bytes,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': 'inline; filename="certificate"',
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  })
  return sendStream(event, content.stream)
})
