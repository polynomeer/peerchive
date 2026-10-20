import { createBindCode } from '../../../../../modules/discord/bindings'

/** POST /api/v1/projects/:id/discord/bind-code — owner만(아니면 403, 비멤버 404). 201 {code, expiresAt}. */
export default defineApiHandler(async (event) => {
  const result = await createBindCode(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 201)
  return result
})
