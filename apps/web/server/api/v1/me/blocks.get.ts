import { listMyBlocks } from '../../../modules/social/blocks'

/** GET /api/v1/me/blocks — 내 차단 목록(S-04). 내가 차단한 그 페르소나만 보입니다(상대의 다른 페르소나 없음). */
export default defineApiHandler((event) => listMyBlocks(requireDb(), requireActor(event)))
