import { voteOnPoll } from '../../../../../../../modules/community/room-polls'

/** POST /api/v1/community/spaces/:slug/polls/:id/votes {optionIndex} — 한 번만(409 already_voted), 마감 뒤 409 poll_closed(A-02). 201. */
export default defineApiHandler(async (event) => {
  const result = await voteOnPoll(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
