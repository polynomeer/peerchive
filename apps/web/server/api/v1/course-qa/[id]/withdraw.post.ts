import { withdrawCourseQa } from '../../../../modules/course-hub/course-qa'

/** POST /api/v1/course-qa/:id/withdraw — 질문한 사람·답한 사람 누구나 즉시 철회(C-09). 200(이미 철회도 200), 404(당사자 아님·없음). */
export default defineApiHandler(async (event) => withdrawCourseQa(requireDb(), requireActor(event), getRouterParam(event, 'id')))
