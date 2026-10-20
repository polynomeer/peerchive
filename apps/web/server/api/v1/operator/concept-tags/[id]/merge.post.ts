import { mergeConceptTag } from '../../../../../modules/catalog/merge'

/** POST /api/v1/operator/concept-tags/:id/merge {into} — 운영자만(403). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return mergeConceptTag(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
