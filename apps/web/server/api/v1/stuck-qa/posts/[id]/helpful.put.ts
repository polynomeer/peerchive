import { setStuckQaHelpful } from '../../../../../modules/course-hub/stuck-qa'

/** PUT /api/v1/stuck-qa/posts/:id/helpful — 남의 게시 중인 답변에 "도움됐어요". 200 {helpedByMe}(개수 없음, 정렬에만 씀). 422 own_post·not_answer. */
export default defineApiHandler(async (event) => setStuckQaHelpful(requireDb(), requireActor(event), getRouterParam(event, 'id'), true))
