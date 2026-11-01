import { updateRoomEvent } from '../../../../../../../modules/community/room-events'

/** PATCH /api/v1/community/spaces/:slug/events/:id {title?, description?, locationText?} — 방장·운영진만(A-02). 시각·반복은 바꾸지 않음(422 schedule_fixed). */
export default defineApiHandler(async (event) =>
  updateRoomEvent(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id'), await readJsonBody(event)),
)
