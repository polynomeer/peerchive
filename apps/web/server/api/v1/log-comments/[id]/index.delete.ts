import { deleteLogComment } from '../../../../modules/logs/comments'

/** DELETE /api/v1/log-comments/:id — 작성자 본인만(E-10). 본문을 비우고 자리는 남깁니다. 지운 댓글을 돌려줍니다. */
export default defineApiHandler((event) => deleteLogComment(requireDb(), requireActor(event), getRouterParam(event, 'id')))
