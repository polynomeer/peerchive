import { deleteShareLink } from '../../../../../modules/portfolio/share-links'

/** DELETE /api/v1/me/share-links/:id — 열 수 없는 링크(철회·만료·지난 판)를 목록에서 지웁니다. 204, 열린 링크 409 share_link_active, 남의 링크 404. E-07. */
export default defineApiHandler(async (event) => {
  await deleteShareLink(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
