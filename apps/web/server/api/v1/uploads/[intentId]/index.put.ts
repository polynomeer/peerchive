import { receiveUpload } from '../../../../modules/artifacts/artifacts'

/**
 * PUT /api/v1/uploads/:intentId (본문 = 파일 내용 그대로) — 의도를 만든 사용자만. CSRF Origin 검사 대상입니다.
 * 선언 크기를 넘으면 413, 모자라면 422 `size_mismatch`(받던 내용은 지움). 만료 410, 이미 받음 409.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const header = getRequestHeader(event, 'content-length')
  const contentLength = header !== undefined && /^\d+$/.test(header) ? Number(header) : null
  return receiveUpload(requireDb(), useObjectStorage(), actor, getRouterParam(event, 'intentId'), event.node.req, {
    contentLength,
  })
})
