import { listMyMutes } from '../../../modules/social/blocks'

/** GET /api/v1/me/mutes — 내 뮤트 목록(S-04). */
export default defineApiHandler((event) => listMyMutes(requireDb(), requireActor(event)))
