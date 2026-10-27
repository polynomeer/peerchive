import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { spaceUnhideItem } from '../../../../../modules/community/moderation'

/** POST /api/v1/community/posts/:id/unhide {note?} — 방 운영진 가리기 되돌리기(C-06). 200 + 스레드. 403, 404, 409 not_space_hidden. */
export default defineApiHandler(async (event) => spaceUnhideItem(requireDb(), requireActor(event), 'post', getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
