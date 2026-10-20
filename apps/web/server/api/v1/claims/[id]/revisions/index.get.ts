import { listClaimRevisions } from '../../../../../modules/contribution/claims'

/** GET /api/v1/claims/:id/revisions — 멤버. 모든 revision(오래된 순)과 각 revision에 붙은 확인. */
export default defineApiHandler((event) =>
  listClaimRevisions(requireDb(), requireActor(event), getRouterParam(event, 'id')),
)
