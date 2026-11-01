import { getStuckQaThread } from '../../../../../modules/course-hub/stuck-qa'

/** GET /api/v1/stuck-qa/threads/:id — 스레드(질문자·익명N·작성자 표시, 이름·사람 id 없음). 로그인 없이도. 지금 보이지 않으면 404. */
export default defineApiHandler(async (event) => {
  const auth = event.context.auth
  setResponseHeader(event, 'cache-control', 'private, no-store')
  setResponseHeader(event, 'x-robots-tag', 'noindex')
  return getStuckQaThread(requireDb(), auth ? { userId: auth.user.id } : null, getRouterParam(event, 'id'))
})
