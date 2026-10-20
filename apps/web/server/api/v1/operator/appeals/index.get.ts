import { listAppeals } from '../../../../modules/moderation/operator'

/** GET /api/v1/operator/appeals?status=open|upheld|reversed — 운영자만. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return listAppeals(requireDb(), actor, getQuery(event))
})
