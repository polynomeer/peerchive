import { searchConceptTags } from '../../../modules/catalog/tags'

/** GET /api/v1/concept-tags?q= — 개념 태그 검색(정본만, 최대 20개). */
export default defineApiHandler((event) => {
  requireActor(event)
  return searchConceptTags(requireDb(), getQuery(event).q)
})
