import { listMyCuratedCourses } from '../../../../modules/curators/portfolio'

/** GET /api/v1/me/curated-courses — 내가 지금 큐레이터인 과목(E-03). 아니면 빈 목록. */
export default defineApiHandler((event) => listMyCuratedCourses(requireDb(), requireActor(event)))
