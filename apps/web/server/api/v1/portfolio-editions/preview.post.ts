import { previewEdition } from '../../../modules/portfolio/editions'

/** POST /api/v1/portfolio-editions/preview — 저장하지 않고 공개 보기 그대로 만들어 봅니다(같은 검증, 200). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return previewEdition(requireDb(), actor, await readJsonBody(event))
})
