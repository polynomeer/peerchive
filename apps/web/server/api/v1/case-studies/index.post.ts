import { createCaseStudy } from '../../../modules/portfolio/case-studies'

/**
 * POST /api/v1/case-studies {releaseSlug, jobTarget, revealSelf?} — 로그인. 201 + 템플릿 초안(문장마다 스냅샷 인용).
 * 지금 게시 중이 아니면 404, 그 release의 팀원이 아니면 422 releaseSlug: not_member, 익명이던 사람은 revealSelf: true가 없으면 422, 409 limit_reached, 429.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const caseStudy = await createCaseStudy(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, 201)
  return caseStudy
})
