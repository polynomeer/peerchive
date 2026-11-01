import { setQuestionsAllowed } from '../../../../../../modules/course-hub/stuck-qa'

/** PUT /api/v1/stuck-qa/cards/:slug/:itemKey {questionsAllowed} — 그 막힘 로그 작성자만(403 not_log_author). 과목 연결이 없으면 409 course_not_linked. */
export default defineApiHandler(async (event) =>
  setQuestionsAllowed(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'itemKey'), await readJsonBody(event)),
)
