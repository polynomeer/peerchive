import { openLoungeMedia } from '../../../../../../../modules/community/lounge-media'

/**
 * GET /api/v1/community/posts/:id/media/:mediaId/file?exp=&sig= — 로그인 + 그 사람에게 맞는 5분 서명 + 지금 그 글을 읽을 수 있음 + 글이 게시 중 +
 * 검사 통과(메타데이터 제거)일 때만 이미지 내용(A-04). 그 밖은 모두 404. 앨범·산출물과 같은 보호 헤더(nosniff·sandbox CSP·no-store), 이름은 고정.
 */
export default defineApiHandler(async (event) => {
  const query = getQuery(event)
  const content = await openLoungeMedia(requireDb(), useObjectStorage(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'mediaId'), {
    exp: query.exp,
    sig: query.sig,
  })
  setResponseHeaders(event, {
    'content-type': content.mediaType,
    'content-length': content.bytes,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': 'inline; filename="image"',
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  })
  return sendStream(event, content.stream)
})
