import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { createComment } from '../../../../../modules/community/posts'

/**
 * POST /api/v1/community/posts/:id/comments {body, parentCommentId?, nameMode?} — 댓글·답글(한 단계). 201 + 스레드.
 * 403, 404, 409 post_not_open·parent_not_open·space_not_active, 413, 422, 429.
 */
export default defineApiHandler(async (event) => {
  const result = await createComment(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event))
  setResponseStatus(event, 201)
  return result
})
