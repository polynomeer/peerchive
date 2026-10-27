import { readCommunityWriteBody } from '../../../../../modules/community/http'
import { spaceHideItem } from '../../../../../modules/community/moderation'

/**
 * POST /api/v1/community/posts/:id/hide {publicReason, note?} — 방 운영진(방장·admin·moderator, 공식 페이지 모더레이터)이 자기 공간의 글을 가립니다(C-06).
 * 200 + 스레드(일반 멤버와 같은 DTO). 403 moderate_not_allowed·write_restricted 없음, 404, 409 target_not_open·space_not_active, 422, 429.
 */
export default defineApiHandler(async (event) => spaceHideItem(requireDb(), requireActor(event), 'post', getRouterParam(event, 'id'), await readCommunityWriteBody(event)))
