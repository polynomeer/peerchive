import { withdrawEndorsement } from '../../../../modules/contribution/claims'

/** DELETE /api/v1/claim-revisions/:id/endorsement — 내 확인·이의 철회. 현재 revision에만(아니면 409 not_current). 204. */
export default defineApiHandler(async (event) => {
  await withdrawEndorsement(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
