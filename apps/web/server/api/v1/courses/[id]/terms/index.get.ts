import { listCourseTerms } from '../../../../../modules/catalog/catalog'

/** GET /api/v1/courses/:id/terms — 개설 학기 목록(최근순). */
export default defineApiHandler((event) => {
  requireActor(event)
  return listCourseTerms(requireDb(), getRouterParam(event, 'id'))
})
