import { previewCandidate } from '../../../../modules/publication/candidates'

/** GET /api/v1/candidates/:id/preview — 저장된 공개 스냅샷 그대로(멤버·당사자). 그 밖에는 404. 검색엔진 색인 금지. */
export default defineApiHandler(async (event) => {
  setResponseHeader(event, 'x-robots-tag', 'noindex')
  return previewCandidate(requireDb(), requireActor(event), getRouterParam(event, 'id'))
})
