import { openAlbumPhoto } from '../../../../../../../../modules/community/room-album'

/**
 * GET /api/v1/community/spaces/:slug/album/photos/:id/file?exp=&sig= — 로그인 + 그 사람에게 맞는 5분 서명 + 지금 방 멤버 + 검사 통과(메타데이터 제거)일 때만
 * 사진 내용(A-02). 그 밖은 모두 404. 산출물·수료증과 같은 보호 헤더(nosniff·sandbox CSP·no-store), 이름은 고정(원래 파일 이름은 저장하지 않음).
 */
export default defineApiHandler(async (event) => {
  const query = getQuery(event)
  const content = await openAlbumPhoto(requireDb(), useObjectStorage(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id'), {
    exp: query.exp,
    sig: query.sig,
  })
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
