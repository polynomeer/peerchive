import { saveInterviewPrep } from '../../../../modules/portfolio/interview-prep'

/** PUT /api/v1/case-studies/:id/interview-prep {questionKey, note?, shown?} — 작성자만. 422 not_current·too_long, 409 limit_reached, 429(E-06). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return saveInterviewPrep(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
