import { markNoticeRead } from '../../../../../modules/community/notice-reads'

/** POST /api/v1/community/posts/:id/read — 동문회·OB 방 공지를 읽었다고 표시(A-02, 멱등). 읽음 수와 내가 읽었는지만 돌려줍니다(누가 읽었는지 없음). */
export default defineApiHandler(async (event) => markNoticeRead(requireDb(), requireActor(event), getRouterParam(event, 'id')))
