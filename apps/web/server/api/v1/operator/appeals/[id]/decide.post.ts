import { decideAppeal } from '../../../../../modules/moderation/operator'

/** POST /api/v1/operator/appeals/:id/decide {decision: uphold|reverse, note} — 운영자만. 되돌리면 조치를 풉니다. 409 already_decided. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return decideAppeal(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
