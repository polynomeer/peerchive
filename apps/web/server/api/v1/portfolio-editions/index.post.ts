import { createEdition } from '../../../modules/portfolio/editions'

/**
 * POST /api/v1/portfolio-editions {headline?, featuredCaseStudyIds[], competencies[{label, preset?, evidence?}], skillsDeclared[]} — 로그인.
 * 201 + 새 판(지금 판, 바꾸지 않음). 422(대표 케이스·근거·이름), 429.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const edition = await createEdition(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, 201)
  return edition
})
