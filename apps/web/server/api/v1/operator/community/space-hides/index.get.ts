import { listSpaceHides } from '../../../../../modules/community/moderation'

/** GET /api/v1/operator/community/space-hides — 방 운영진 가리기 목록(최근 100). 운영자만. */
export default defineApiHandler(async (event) => listSpaceHides(requireDb(), requireActor(event)))
