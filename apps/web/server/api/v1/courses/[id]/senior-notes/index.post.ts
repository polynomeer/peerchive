import { createSeniorNote } from '../../../../../modules/course-hub/senior-notes'

/**
 * POST /api/v1/courses/:id/senior-notes {displayMode, displayName?, termLabel?, totalTimeBucket?, answers, noAnswersConfirmed: true}
 * — 로그인. 201 + 초안. 없는 과목 404, 작성 자격 없음 403 hub_write_not_allowed, 과목당 한도 409 limit_reached, 422, 429.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const note = await createSeniorNote(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return note
})
