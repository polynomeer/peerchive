import { setEndorsement } from '../../../../modules/contribution/claims'

/**
 * PUT /api/v1/claim-revisions/:id/endorsement {status: 'confirmed'|'disputed', note?} — 작성자가 아닌 owner/editor/reviewer.
 * 200(갱신한 선언). 이전 revision 409 not_current, 자기 선언 403 self_endorsement, viewer 403, 이의에 메모 없음 422.
 */
export default defineApiHandler(async (event) =>
  setEndorsement(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
