import { createRoomEvent } from '../../../../../../modules/community/room-events'

/** POST /api/v1/community/spaces/:slug/events {title, description?, locationText?, startsAt, endsAt?, recurrence?, repeatUntil?} — 방장·운영진만(A-02). 201. */
export default defineApiHandler(async (event) => {
  const result = await createRoomEvent(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
