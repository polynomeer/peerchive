import { setMemberCohort } from '../../../../../../../modules/community/room-profiles'

/** PUT /api/v1/community/spaces/:slug/room-profiles/:id/cohort {cohortLabel} — 방장·운영진이 멤버의 기수를 고침(A-01, 이력 남김). 그 밖의 멤버 403. */
export default defineApiHandler(async (event) =>
  setMemberCohort(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id'), await readJsonBody(event)),
)
