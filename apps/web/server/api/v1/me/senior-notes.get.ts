import { listMySeniorNotes } from '../../../modules/course-hub/senior-notes'

/** GET /api/v1/me/senior-notes?course= — 내가 쓴 선배 노트(초안 포함, 점검 경고 포함). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return listMySeniorNotes(requireDb(), actor, getQuery(event).course)
})
