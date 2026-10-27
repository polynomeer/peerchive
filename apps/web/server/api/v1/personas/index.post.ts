import { createDisplayPersona } from '../../../modules/social/personas'

/**
 * POST /api/v1/personas {handle, displayName, headline?, jobTargets?, schoolLabel?, gradTerm?, contactPolicy?, openToWork?, showAffiliationBadge?,
 * accountPrivacy?, showFollowerCount?} — 표시명 페르소나 만들기(S-01, ADR 0028). **201**. 실명 페르소나는 `PATCH /me/profile`이 만듭니다.
 * 409 `real_persona_required`·`persona_exists`(계정당 하나), 422 `handle: too_short|invalid_format|reserved|taken`·`displayName`.
 */
export default defineApiHandler(async (event) => {
  const persona = await createDisplayPersona(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return persona
})
