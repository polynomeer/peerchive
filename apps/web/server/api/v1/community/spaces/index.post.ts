import { createRoom } from '../../../../modules/community/spaces'

/** POST /api/v1/community/spaces {name, description?, schoolId?, nameMode, discovery?, joinPolicy?, capacity?} — 사용자 방 만들기.
 * 201. 403 affiliation_required, 404(학교), 422(name reserved 등), 429. */
export default defineApiHandler(async (event) => {
  const result = await createRoom(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
