import { unpublishCaseStudy } from '../../../../modules/portfolio/case-studies'

/** POST /api/v1/case-studies/:id/unpublish — 작성자만. 게시 중이 아니면 409 not_published. */
export default defineApiHandler((event) => unpublishCaseStudy(requireDb(), requireActor(event), getRouterParam(event, 'id')))
