import { openOperatorAlbumPhoto } from '../../../../../../../modules/community/room-item-reports'

/**
 * GET /api/v1/operator/community/room-items/album-photos/:id/file?exp=&sig= — 신고된 앨범 사진 하나(A-07). 운영자 세션 + 그 운영자에게 맞는 5분 서명 + 검사 통과일 때만,
 * 그 밖은 404. 앨범 사진 경로와 같은 보호 헤더.
 */
export default defineApiHandler(async (event) => {
  const query = getQuery(event)
  const content = await openOperatorAlbumPhoto(requireDb(), useObjectStorage(), requireActor(event), getRouterParam(event, 'id'), { exp: query.exp, sig: query.sig })
  setResponseHeaders(event, {
    'content-type': content.mediaType,
    'content-length': content.bytes,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': 'inline; filename="photo"',
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  })
  return sendStream(event, content.stream)
})
