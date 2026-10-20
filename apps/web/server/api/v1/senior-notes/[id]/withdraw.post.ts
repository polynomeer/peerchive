import { withdrawSeniorNote } from '../../../../modules/course-hub/senior-notes'

/** POST /api/v1/senior-notes/:id/withdraw — 작성자만, 즉시 공개에서 내려갑니다. 이미 철회 200, 게시된 적 없음 409 not_published. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return withdrawSeniorNote(requireDb(), actor, getRouterParam(event, 'id'))
})
