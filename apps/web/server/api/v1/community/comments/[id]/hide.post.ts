import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { spaceHideItem } from '../../../../../modules/community/moderation'

/** POST /api/v1/community/comments/:id/hide {publicReason, note?} — 방 운영진이 자기 공간의 댓글을 가립니다(C-06). 글 가리기와 같은 규칙. */
export default defineApiHandler(async (event) => spaceHideItem(requireDb(), requireActor(event), 'comment', getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
