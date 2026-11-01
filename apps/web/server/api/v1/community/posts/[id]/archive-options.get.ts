import { getArchiveOptions } from '../../../../../modules/community/archive-transfers'

/**
 * GET /api/v1/community/posts/:id/archive-options[?commentId=] — "아카이브로 옮기기" 선택지(C-09, 글쓴이만). A-06: commentId면 토픽의 내 답변을
 * 선배 노트로 옮기는 선택지. 200, 403 not_author, 404.
 */
export default defineApiHandler(async (event) =>
  getArchiveOptions(requireDb(), requireActor(event), getRouterParam(event, 'id'), new Date(), getQuery(event).commentId),
)
