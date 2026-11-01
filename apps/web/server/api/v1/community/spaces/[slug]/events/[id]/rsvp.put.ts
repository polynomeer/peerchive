import { respondToEvent } from '../../../../../../../modules/community/room-events'

/** PUT /api/v1/community/spaces/:slug/events/:id/rsvp {date, response: going|not_going|maybe|null} — 회차별 참석 응답(A-02). 방 멤버만. */
export default defineApiHandler(async (event) =>
  respondToEvent(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id'), await readJsonBody(event)),
)
