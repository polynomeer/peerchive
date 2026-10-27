import { deleteComment } from '../../../../../modules/community/posts'

/** DELETE /api/v1/community/comments/:id — 본인 댓글 지우기(자리 표시, 번호·답글 유지). 200 + 스레드. */
export default defineApiHandler(async (event) => deleteComment(requireDb(), requireActor(event), getRouterParam(event, 'id')))
