import { searchSchools } from '../../../modules/catalog/catalog'

/** GET /api/v1/schools?q= — 학교 검색(정본만, 최대 20개, 학생 작성). 로그인 필요. */
export default defineApiHandler((event) => {
  requireActor(event)
  return searchSchools(requireDb(), getQuery(event).q)
})
