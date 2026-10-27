import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { setAcceptedAnswer } from '../../../../../modules/community/posts'

/**
 * PUT /api/v1/community/posts/:id/accepted-answer {commentId} — 질문 게시판 글의 글쓴이가 최상위 댓글 하나를 채택합니다(C-09). 200 + 스레드.
 * 403 not_author, 404, 409 not_question_board·not_open·space_not_active·comment_not_open, 422 commentId: invalid|not_top_level.
 */
export default defineApiHandler(async (event) => setAcceptedAnswer(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
