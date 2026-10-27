import { updateBoard } from '../../../../modules/community/spaces'

/** PATCH /api/v1/community/boards/:id {title?, writeRole?, position?} — 게시판 만들기와 같은 권한. 공지는 moderator 쓰기 고정. */
export default defineApiHandler(async (event) => updateBoard(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
