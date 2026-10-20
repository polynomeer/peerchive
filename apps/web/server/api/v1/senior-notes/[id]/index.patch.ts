import { updateSeniorNote } from '../../../../modules/course-hub/senior-notes'

/** PATCH /api/v1/senior-notes/:id {expectedVersion, ...} — 작성자만(아니면 404). 게시된 노트를 고치면 draft로 돌아갑니다. 409 version_conflict·hidden. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return updateSeniorNote(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
