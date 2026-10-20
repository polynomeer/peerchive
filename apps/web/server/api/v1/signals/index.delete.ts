import { deleteSignal } from '../../../modules/course-hub/signals'

/** DELETE /api/v1/signals {target, kind} — 로그인. 내 신호를 거둡니다. 200, 지금 공개가 아니면 404. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return deleteSignal(requireDb(), actor, await readJsonBody(event))
})
