import { listBoards } from '../../../../../../modules/community/spaces'

/** GET /api/v1/community/spaces/:slug/boards — 읽을 수 있는 사람만(404). 게시판마다 canWrite. */
export default defineApiHandler(async (event) => listBoards(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
