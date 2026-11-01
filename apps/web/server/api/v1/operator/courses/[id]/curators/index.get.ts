import { listCourseCurators } from '../../../../../../modules/curators/assignments'

/** GET /api/v1/operator/courses/:id/curators — 운영자만(E-03). 그 과목(정본)의 지금 큐레이터(사용자 id·계정 이름·지정 시각). */
export default defineApiHandler((event) => listCourseCurators(requireDb(), requireActor(event), getRouterParam(event, 'id')))
