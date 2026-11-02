import { applyCasePolish } from '../../../../../modules/ai/case-polish'

/** POST /api/v1/case-studies/:id/ai-polish/apply {expectedVersion, accept[{section, index, text?}]} — 문장마다 받아들이기(E-14). 409 no_proposal·version_conflict, 422. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return applyCasePolish(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
