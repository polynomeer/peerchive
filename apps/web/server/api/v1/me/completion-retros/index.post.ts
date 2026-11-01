import { createCompletionRetro } from '../../../../modules/institutions/completion-retros'

/**
 * POST /api/v1/me/completion-retros {affiliationId, displayMode, labelScope?, showCohort?, answers, guidelinesConfirmed: true, confirmWarnings?}
 * — 수료 회고 쓰기(A-06, P2 institutions 플래그, 꺼짐 404). 201 + 내 회고. 별점·연봉·추천 점수 같은 다른 키는 422.
 * 403 display_persona_required, 409 retro_exists·checks_unconfirmed, 422, 429.
 */
export default defineApiHandler(async (event) => {
  const retro = await createCompletionRetro(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return retro
})
