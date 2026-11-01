import { recommendOnReport } from '../../../../../../../modules/curators/report-review'

/** PUT /api/v1/curator/courses/:id/reports/:reportId/recommendation {recommendation: dismiss|hide, note?} — 그 과목 큐레이터만(E-03). 의견만, 처리는 운영자. */
export default defineApiHandler(async (event) =>
  recommendOnReport(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'reportId'), await readJsonBody(event)),
)
