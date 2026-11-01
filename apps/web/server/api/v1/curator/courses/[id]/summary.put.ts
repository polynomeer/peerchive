import { putAssignmentTypeSummary } from '../../../../../modules/curators/summaries'

/** PUT /api/v1/curator/courses/:id/summary {body, expectedVersion} — 큐레이터 또는 운영자(E-03). 과제 유형 요약 쓰기·고치기·비우기. 409 version_conflict, 429. */
export default defineApiHandler(async (event) => ({ summary: await putAssignmentTypeSummary(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)) }))
