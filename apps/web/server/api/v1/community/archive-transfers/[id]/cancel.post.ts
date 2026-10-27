import { cancelArchiveTransfer } from '../../../../../modules/community/archive-transfers'

/** POST /api/v1/community/archive-transfers/:id/cancel — 요청한 사람이 취소(C-09). 200, 404, 409 not_pending. */
export default defineApiHandler(async (event) => cancelArchiveTransfer(requireDb(), requireActor(event), getRouterParam(event, 'id')))
