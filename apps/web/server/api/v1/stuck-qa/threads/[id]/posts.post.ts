import { createStuckQaAnswer } from '../../../../../modules/course-hub/stuck-qa'

/** POST /api/v1/stuck-qa/threads/:id/posts {body, countAsContribution?} — 답변. 201 + 스레드. 403, 409 questions_closed, 429. */
export default defineApiHandler(async (event) => {
  const thread = await createStuckQaAnswer(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return thread
})
