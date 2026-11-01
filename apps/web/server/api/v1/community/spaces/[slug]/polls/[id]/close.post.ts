import { closeRoomPoll } from '../../../../../../../modules/community/room-polls'

/** POST /api/v1/community/spaces/:slug/polls/:id/close — 방장·운영진이 일찍 마감(A-02). 멱등. */
export default defineApiHandler(async (event) => closeRoomPoll(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id')))
