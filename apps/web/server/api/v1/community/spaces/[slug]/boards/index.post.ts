import { createBoard } from '../../../../../../modules/community/spaces'

/** POST /api/v1/community/spaces/:slug/boards {kind, title, writeRole?} — 사용자 방 owner·admin(최대 10개), 공식 페이지 운영자. 201. */
export default defineApiHandler(async (event) => {
  const result = await createBoard(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
