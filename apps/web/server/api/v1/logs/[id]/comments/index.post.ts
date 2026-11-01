import { createLogComment } from '../../../../../modules/logs/comments'

/**
 * POST /api/v1/logs/:id/comments {body} — 피드백 댓글 쓰기(E-10). owner/editor/reviewer(viewer 403), 비멤버 404,
 * 보관된 과제 409 `project_archived`, 본문 1~2000자(422), 시간 한도 429.
 */
export default defineApiHandler(async (event) => {
  const comment = await createLogComment(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return comment
})
