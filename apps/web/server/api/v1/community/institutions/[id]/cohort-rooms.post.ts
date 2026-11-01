import { createCohortRoom } from '../../../../../modules/community/institution-pages'

/** POST /api/v1/community/institutions/:id/cohort-rooms {cohortLabel, name?, description?, nameMode?} — 운영진·운영자(I-02). 201 + 공간 상세. */
export default defineApiHandler(async (event) => {
  const result = await createCohortRoom(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
