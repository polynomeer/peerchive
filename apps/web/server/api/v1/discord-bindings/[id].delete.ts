import { unbindChannel } from '../../../modules/discord/bindings'

/** DELETE /api/v1/discord-bindings/:id — owner만. 204. 승인 대기 📌 요청은 만료 처리(내용 삭제). */
export default defineApiHandler(async (event) => {
  await unbindChannel(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
