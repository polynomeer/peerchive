import { isInlineMediaType } from '@peerchive/domain'
import { contentDisposition } from '@peerchive/files'
import { openArtifactContent } from '../../../../../../modules/artifacts/artifacts'

/**
 * GET /api/v1/artifacts/:id/versions/:versionId/content — 같은 프로젝트 active 멤버, clean 버전만. 그 밖에는 모두 404.
 *
 * 응답 헤더(ADR 0007): 판별한 Content-Type, nosniff, `sandbox; default-src 'none'` CSP(문서로 열려도 스크립트·하위 요청 차단),
 * 이미지는 inline·PDF는 attachment(RFC 5987 파일 이름), 공유 캐시 금지.
 * 내용은 clean 객체(이미지는 메타데이터를 지운 것)이고 Content-Length·ETag도 그 크기·해시입니다.
 */
export default defineApiHandler(async (event) => {
  const content = await openArtifactContent(
    requireDb(),
    useObjectStorage(),
    requireActor(event),
    getRouterParam(event, 'id'),
    getRouterParam(event, 'versionId'),
  )
  setResponseHeaders(event, {
    'content-type': content.mediaType,
    'content-length': content.bytes,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': contentDisposition(content.fileName, isInlineMediaType(content.mediaType)),
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    etag: `"v-${content.sha256.slice(0, 16)}"`,
  })
  return sendStream(event, content.stream)
})
