import { dismissReport } from '../../../../../modules/moderation/operator'

/** POST /api/v1/operator/reports/:id/dismiss {note} — 운영자만. 기각(조치 없음), 보류를 풉니다. 409 already_closed. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return dismissReport(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
