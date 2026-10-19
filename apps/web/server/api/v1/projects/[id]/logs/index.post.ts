import { createLog } from '../../../../../modules/logs/logs'

/**
 * POST /api/v1/projects/:id/logs {tag, body?, payload, links?, claimedDate?, resolvesEntryId?, clientId?}
 * — active owner/editor. 새로 만들면 201, 같은 clientId 재전송이면 기존 로그를 200으로 돌려줍니다.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const { log, created } = await createLog(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, created ? 201 : 200)
  return log
})
