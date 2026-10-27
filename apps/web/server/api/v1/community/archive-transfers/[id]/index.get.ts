import { getArchiveTransfer } from '../../../../../modules/community/archive-transfers'

/** GET /api/v1/community/archive-transfers/:id — 요청한 사람·동의를 요청받은 사람만(C-09, 원 글 공간을 읽을 수 있어야 함). 200, 404. */
export default defineApiHandler(async (event) => getArchiveTransfer(requireDb(), requireActor(event), getRouterParam(event, 'id')))
