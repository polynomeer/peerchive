import { editLogComment } from '../../../../modules/logs/comments'

/** PATCH /api/v1/log-comments/:id {body} — 작성자 본인만 본문 수정(E-10). 남의 댓글 403, 비멤버 404. */
export default defineApiHandler(async (event) =>
  editLogComment(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
