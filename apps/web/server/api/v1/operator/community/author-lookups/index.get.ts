import { listAuthorLookups } from '../../../../../modules/community/moderation'

/** GET /api/v1/operator/community/author-lookups?target=<글·댓글 id> — 작성자 확인 기록(최근 100, 확인한 작성자 없음). 운영자만. */
export default defineApiHandler(async (event) => listAuthorLookups(requireDb(), requireActor(event), getQuery(event)))
