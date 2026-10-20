import { updateCaseStudy } from '../../../../modules/portfolio/case-studies'

/** PATCH /api/v1/case-studies/:id {expectedVersion, title?, sections?} — 작성자만. 409 version_conflict·unavailable, 422(인용이 스냅샷에 없음 등). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return updateCaseStudy(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
