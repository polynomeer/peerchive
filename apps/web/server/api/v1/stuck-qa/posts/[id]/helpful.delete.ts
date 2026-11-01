import { setStuckQaHelpful } from '../../../../../modules/course-hub/stuck-qa'

/** DELETE /api/v1/stuck-qa/posts/:id/helpful — "도움됐어요" 거두기. 200 {helpedByMe: false}. */
export default defineApiHandler(async (event) => setStuckQaHelpful(requireDb(), requireActor(event), getRouterParam(event, 'id'), false))
