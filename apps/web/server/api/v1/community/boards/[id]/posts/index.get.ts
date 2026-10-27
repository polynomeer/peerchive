import { listBoardPosts } from '../../../../../../modules/community/posts'

/** GET /api/v1/community/boards/:id/posts?cursor= — 게시판 글 목록(최신순 20개, 지운 글 제외·가린 글 자리 표시). 읽을 수 없으면 404. */
export default defineApiHandler(async (event) => listBoardPosts(requireDb(), requireActor(event), getRouterParam(event, 'id'), getQuery(event)))
