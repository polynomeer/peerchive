import { cancelRoomEvent } from '../../../../../../../modules/community/room-events'

/** POST /api/v1/community/spaces/:slug/events/:id/cancel — 방장·운영진만(A-02). 멱등. */
export default defineApiHandler(async (event) => cancelRoomEvent(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id')))
