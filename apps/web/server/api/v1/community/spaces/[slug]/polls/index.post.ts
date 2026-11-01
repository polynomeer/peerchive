import { createRoomPoll } from '../../../../../../modules/community/room-polls'

/** POST /api/v1/community/spaces/:slug/polls {question, options[], closesAt} — 방장·운영진만(A-02). 201. */
export default defineApiHandler(async (event) => {
  const result = await createRoomPoll(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
