import { setLogCommentHidden } from '../../../../modules/logs/comments'

/** PUT /api/v1/log-comments/:id/hidden {hidden} — owner만 숨김·숨김 해제(E-10). 지운 댓글 409 `comment_deleted`. */
export default defineApiHandler(async (event) =>
  setLogCommentHidden(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
