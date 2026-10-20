import { publishCaseStudy } from '../../../../modules/portfolio/case-studies'

/** POST /api/v1/case-studies/:id/publish {expectedVersion, confirmWarnings?} — 작성자만. 409 uncited_sentences·checks_unconfirmed·unavailable·empty·version_conflict. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return publishCaseStudy(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
