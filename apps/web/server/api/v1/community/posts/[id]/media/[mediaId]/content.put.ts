import { uploadLoungeMedia } from '../../../../../../../modules/community/lounge-media'

/**
 * PUT /api/v1/community/posts/:id/media/:mediaId/content (본문 = 파일 내용) — 라운지 이미지 올리기(A-04). 올린 본인만, CSRF Origin 검사 대상.
 * 선언 크기 초과 413, 모자람 422, 이미 받음 409, 15분이 지나면 410. 받은 뒤 worker가 검사·메타데이터 제거를 합니다.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const header = getRequestHeader(event, 'content-length')
  const contentLength = header !== undefined && /^\d+$/.test(header) ? Number(header) : null
  return uploadLoungeMedia(requireDb(), useObjectStorage(), actor, getRouterParam(event, 'id'), getRouterParam(event, 'mediaId'), event.node.req, { contentLength })
})
