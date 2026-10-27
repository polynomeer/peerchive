import { getPost } from '../../../../../modules/community/posts'

/** GET /api/v1/community/posts/:id — 글 + 댓글(답글 한 단계). 작성자 id 없음(방장·모더레이터에게도 같음). 읽을 수 없으면 404. */
export default defineApiHandler(async (event) => getPost(requireDb(), requireActor(event), getRouterParam(event, 'id')))
