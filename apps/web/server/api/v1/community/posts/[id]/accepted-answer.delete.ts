import { setAcceptedAnswer } from '../../../../../modules/community/posts'

/** DELETE /api/v1/community/posts/:id/accepted-answer — 채택을 풉니다(C-09, 글쓴이만). 200 + 스레드. 403 not_author, 404, 409 not_question_board·not_open. */
export default defineApiHandler(async (event) => setAcceptedAnswer(requireDb(), requireActor(event), getRouterParam(event, 'id'), null))
