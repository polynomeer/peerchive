import { getCaseStudy } from '../../../../modules/portfolio/case-studies'

/** GET /api/v1/case-studies/:id — 작성자만(아니면 404). 문장·인용·출처 없는 문장·점검 경고·고정 release 스냅샷. */
export default defineApiHandler((event) => getCaseStudy(requireDb(), requireActor(event), getRouterParam(event, 'id')))
