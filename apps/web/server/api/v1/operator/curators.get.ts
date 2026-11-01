import { listAllCurators } from '../../../modules/curators/assignments'

/** GET /api/v1/operator/curators — 운영자만(E-03). 지금 큐레이터 전체(과목·사용자 id·계정 이름·지정 시각). */
export default defineApiHandler((event) => listAllCurators(requireDb(), requireActor(event)))
