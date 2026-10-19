import { reviseLog } from '../../../../../modules/logs/logs'

/**
 * POST /api/v1/logs/:id/revisions {expectedRevision, body?, payload, links?, claimedDate?, resolvesEntryId?}
 * — 작성자 본인(owner/editor). 낡은 expectedRevision은 409 {code:'stale_revision', currentRevision}.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const log = await reviseLog(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return log
})
