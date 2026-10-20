import { createAppeal } from '../../../modules/moderation/notices'

/**
 * POST /api/v1/appeals {actionId | reportId, message} — 조치의 당사자만(아니면 404), 조치마다 한 번. 201.
 * 409 not_appealable·already_appealed·already_reversed, 422.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const result = await createAppeal(requireDb(), actor, await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
