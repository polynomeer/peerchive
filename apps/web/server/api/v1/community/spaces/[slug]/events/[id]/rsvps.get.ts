import { listEventRespondents } from '../../../../../../../modules/community/room-events'

/** GET /api/v1/community/spaces/:slug/events/:id/rsvps?date= — 그 회차의 응답자(A-02). 방 멤버만, 익명 방은 수만. */
export default defineApiHandler(async (event) =>
  listEventRespondents(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id'), { date: getQuery(event).date }),
)
