import { discoverSpaces } from '../../../../modules/community/spaces'

/** GET /api/v1/community/spaces/discover?q= — 내 학교 공식 페이지 + 들어갈 수 있는 listed 방(C-02). */
export default defineApiHandler(async (event) => discoverSpaces(requireDb(), requireActor(event), getQuery(event)))
