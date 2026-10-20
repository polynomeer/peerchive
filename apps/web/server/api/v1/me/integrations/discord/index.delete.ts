import { unlinkDiscord } from '../../../../../modules/discord/accounts'

/** DELETE /api/v1/me/integrations/discord — 204. 연결이 없어도 204. */
export default defineApiHandler(async (event) => {
  await unlinkDiscord(requireDb(), requireActor(event))
  setResponseStatus(event, 204)
  return null
})
