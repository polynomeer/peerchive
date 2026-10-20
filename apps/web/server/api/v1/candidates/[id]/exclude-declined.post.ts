import { excludeDeclined } from '../../../../modules/publication/candidates'

/**
 * POST /api/v1/candidates/:id/exclude-declined {consentSelf?} — owner만. 거절한 당사자의 자료를 뺀 새 후보(201).
 * 거절 없음 409 no_declined, 대체됨 409 superseded, 엠바고 409 embargo_active, editor 이하 403, 비멤버 404.
 */
export default defineApiHandler(async (event) => {
  const candidate = await excludeDeclined(
    requireDb(),
    requireActor(event),
    getRouterParam(event, 'id'),
    await readJsonBody(event),
    new Date(),
    { privateOrigins: siteOrigins() },
  )
  setResponseStatus(event, 201)
  return candidate
})
