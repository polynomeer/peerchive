import { searchCourses } from '../../../../../modules/catalog/catalog'

/** GET /api/v1/schools/:id/courses?q= — 그 학교(병합됐으면 정본)의 과목 검색, 최대 20개. 없는 학교 404. */
export default defineApiHandler((event) => {
  requireActor(event)
  return searchCourses(requireDb(), getRouterParam(event, 'id'), getQuery(event).q)
})
