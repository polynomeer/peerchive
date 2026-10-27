import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { spaceUnhideItem } from '../../../../../modules/community/moderation'

/** POST /api/v1/community/comments/:id/unhide {note?} — 방 운영진 가리기 되돌리기(C-06). */
export default defineApiHandler(async (event) => spaceUnhideItem(requireDb(), requireActor(event), 'comment', getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
