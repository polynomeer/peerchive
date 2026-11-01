import { getCuratorWorkspace } from '../../../../../modules/curators/workspace'

/** GET /api/v1/curator/courses/:id — 그 과목 큐레이터 또는 운영자(E-03, 403 curator_only). 요약·태그·병합 제안·팀원 찾기 상태. */
export default defineApiHandler((event) => getCuratorWorkspace(requireDb(), requireActor(event), getRouterParam(event, 'id')))
