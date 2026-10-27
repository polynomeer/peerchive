import { listMyCourseQa } from '../../../modules/course-hub/course-qa'

/** GET /api/v1/me/course-qa — 내가 질문했거나 답한 막힘 Q&A(C-09). 상대가 누구인지는 없습니다. */
export default defineApiHandler(async (event) => listMyCourseQa(requireDb(), requireActor(event)))
