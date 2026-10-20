import { loadCanonicalCourse } from '../../../../../modules/catalog/catalog'
import { listCourseTags } from '../../../../../modules/catalog/tags'

/** GET /api/v1/courses/:id/concept-tags — 과목의 개념 태그(학생 작성). */
export default defineApiHandler(async (event) => {
  requireActor(event)
  const db = requireDb()
  const course = await loadCanonicalCourse(db, getRouterParam(event, 'id'))
  return listCourseTags(db, course.id)
})
