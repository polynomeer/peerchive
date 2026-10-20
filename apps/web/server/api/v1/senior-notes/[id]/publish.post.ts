import { publishSeniorNote } from '../../../../modules/course-hub/senior-notes'

/** POST /api/v1/senior-notes/:id/publish {expectedVersion, confirmWarnings?} — 작성자만. 경고를 확인하지 않으면 409 checks_unconfirmed(+warnings). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return publishSeniorNote(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
