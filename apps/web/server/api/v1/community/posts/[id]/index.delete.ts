import { deletePost } from '../../../../../modules/community/posts'

/** DELETE /api/v1/community/posts/:id — 본인 글 지우기(자리 표시 "작성자가 삭제한 글입니다", 댓글·스레드 번호는 남음). */
export default defineApiHandler(async (event) => deletePost(requireDb(), requireActor(event), getRouterParam(event, 'id')))
