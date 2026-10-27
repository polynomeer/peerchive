import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { editComment } from '../../../../../modules/community/posts'

/** PATCH /api/v1/community/comments/:id {body, expectedVersion} — 본인 댓글 고치기. 200 + 스레드. 403 not_author, 409 not_open·version_conflict. */
export default defineApiHandler(async (event) => editComment(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
