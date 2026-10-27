import { readCommunityWriteBody } from '../../../../../../modules/community/http'
import { createPost } from '../../../../../../modules/community/posts'

/**
 * POST /api/v1/community/boards/:id/posts {title, body, nameMode?} — 글쓰기(이름 표시 방식은 서버가 쓰는 순간 정해 고정). 201.
 * 403 write_not_allowed·real_name_required·display_persona_required, 404, 409 space_not_active, 413, 422 title·body·nameMode(real_not_allowed·mode_fixed), 429.
 */
export default defineApiHandler(async (event) => {
  const result = await createPost(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event))
  setResponseStatus(event, 201)
  return result
})
