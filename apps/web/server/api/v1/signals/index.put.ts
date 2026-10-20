import { putSignal } from '../../../modules/course-hub/signals'

/** PUT /api/v1/signals {target: {kind:'stuck_item', slug, itemKey} | {kind:'senior_note', noteId}, kind} — 로그인. 200, 지금 공개가 아니면 404. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return putSignal(requireDb(), actor, await readJsonBody(event))
})
