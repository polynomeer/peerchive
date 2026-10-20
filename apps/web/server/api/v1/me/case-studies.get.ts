import { listMyCaseStudies } from '../../../modules/portfolio/case-studies'

/** GET /api/v1/me/case-studies — 내 케이스 스터디(읽는 지금 기준 상태, 볼 수 없게 되면 다시 만들 slug). */
export default defineApiHandler((event) => listMyCaseStudies(requireDb(), requireActor(event)))
