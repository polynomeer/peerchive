import { listCuratorReports } from '../../../../../../modules/curators/report-review'

/** GET /api/v1/curator/courses/:id/reports — 그 과목 큐레이터만(E-03). 처리 전 신고 묶음(사유별 개수·지금 공개 내용). 신고자·설명·시각 없음. */
export default defineApiHandler((event) => listCuratorReports(requireDb(), requireActor(event), getRouterParam(event, 'id')))
