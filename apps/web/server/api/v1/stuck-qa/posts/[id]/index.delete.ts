import { withdrawStuckQaPost } from '../../../../../modules/course-hub/stuck-qa'

/** DELETE /api/v1/stuck-qa/posts/:id — 내 글 지우기(본문을 비우고 번호는 남김). 204. 남의 글 404. */
export default defineApiHandler(async (event) => {
  await withdrawStuckQaPost(requireDb(), requireActor(event), getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
