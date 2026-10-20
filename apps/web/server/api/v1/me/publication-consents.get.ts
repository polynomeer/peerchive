import { listMyPublishedConsents } from '../../../modules/publication/releases'

/** GET /api/v1/me/publication-consents — 내가 동의해 지금 게시 중인 공개(동의 철회 대상). */
export default defineApiHandler(async (event) => listMyPublishedConsents(requireDb(), requireActor(event)))
