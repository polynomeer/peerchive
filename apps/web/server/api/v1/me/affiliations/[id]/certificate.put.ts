import { uploadCertificate } from '../../../../../modules/institutions/certificates'

/**
 * PUT /api/v1/me/affiliations/:id/certificate (본문 = 파일 내용) — 수료증 파일 올리기(I-01). 요청한 본인만, CSRF Origin 검사 대상.
 * 선언 크기 초과 413, 모자람 422, 이미 받음 409. 받은 뒤 worker가 검사합니다. 플래그가 꺼져 있으면 404.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const header = getRequestHeader(event, 'content-length')
  const contentLength = header !== undefined && /^\d+$/.test(header) ? Number(header) : null
  return uploadCertificate(requireDb(), useObjectStorage(), actor, getRouterParam(event, 'id'), event.node.req, { contentLength })
})
