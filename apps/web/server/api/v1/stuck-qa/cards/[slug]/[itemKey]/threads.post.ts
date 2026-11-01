import { createStuckQaThread } from '../../../../../../modules/course-hub/stuck-qa'

/** POST /api/v1/stuck-qa/cards/:slug/:itemKey/threads {body} — 질문으로 스레드 열기. 201. 403 hub_write_not_allowed, 409 questions_closed, 422 own_card, 429. */
export default defineApiHandler(async (event) => {
  const thread = await createStuckQaThread(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'itemKey'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return thread
})
