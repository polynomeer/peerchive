import { polishCaseStudy } from '../../../../../modules/ai/case-polish'

/** POST /api/v1/case-studies/:id/ai-polish {expectedVersion} — "AI로 다듬기"(E-14). 409 version_conflict·nothing_to_polish·unavailable, 429, 503 ai_declined·ai_unavailable. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return polishCaseStudy(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
