import { reviseClaim } from '../../../../../modules/contribution/claims'

/**
 * POST /api/v1/claims/:id/revisions {expectedRevision, text?, evidence?} — 작성자 본인만(owner도 403). 201.
 * 낡은 expectedRevision 409 stale_revision. 새 revision은 미확인으로 시작합니다.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const claim = await reviseClaim(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return claim
})
