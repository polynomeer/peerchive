import { listLogRevisions } from '../../../../../modules/logs/logs'

/** GET /api/v1/logs/:id/revisions — 모든 revision(오래된 순). */
export default defineApiHandler((event) =>
  listLogRevisions(requireDb(), requireActor(event), getRouterParam(event, 'id')),
)
