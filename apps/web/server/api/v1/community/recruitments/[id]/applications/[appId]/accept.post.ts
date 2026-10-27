import { acceptApplication } from '../../../../../../../modules/community/recruitments'

/** POST /api/v1/community/recruitments/:id/applications/:appId/accept — 모집자만, 모집 인원까지. 200, 403, 404, 409 recruitment_not_open·not_pending·capacity_full. */
export default defineApiHandler(async (event) =>
  acceptApplication(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'appId')),
)
