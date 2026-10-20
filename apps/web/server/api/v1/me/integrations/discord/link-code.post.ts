import { createLinkCode } from '../../../../../modules/discord/accounts'

/** POST /api/v1/me/integrations/discord/link-code — 201 {code, expiresAt}. 10분·한 번만, 원문은 이 응답에서만. */
export default defineApiHandler(async (event) => {
  const result = await createLinkCode(requireDb(), requireActor(event))
  setResponseStatus(event, 201)
  return result
})
