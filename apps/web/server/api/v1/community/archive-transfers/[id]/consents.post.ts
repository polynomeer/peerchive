import { decideArchiveConsent } from '../../../../../modules/community/archive-transfers'
import { readCommunityWriteBody } from '../../../../../modules/community/http'

/**
 * POST /api/v1/community/archive-transfers/:id/consents {decision: grant|decline, contentHash?, displayMode?} — 동의·거절(C-09). 200 + 요청.
 * 404, 409 not_pending·already_decided·stale_content, 422.
 */
export default defineApiHandler(async (event) => decideArchiveConsent(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
