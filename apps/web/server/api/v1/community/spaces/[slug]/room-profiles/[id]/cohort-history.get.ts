import { listCohortHistory } from '../../../../../../../modules/community/room-profiles'

/** GET /api/v1/community/spaces/:slug/room-profiles/:id/cohort-history — 기수 변경 이력(A-01). 방장·운영진과 본인만(403). */
export default defineApiHandler(async (event) => listCohortHistory(requireDb(), requireActor(event), getRouterParam(event, 'slug'), getRouterParam(event, 'id')))
