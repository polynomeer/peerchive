import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { editPost } from '../../../../../modules/community/posts'

/** PATCH /api/v1/community/posts/:id {title?, body?, expectedVersion} — 본인 글 고치기(이름 표시 방식은 그대로). 403 not_author, 409 not_open·version_conflict. */
export default defineApiHandler(async (event) => editPost(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
