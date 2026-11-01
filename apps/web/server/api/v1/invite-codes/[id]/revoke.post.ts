import { revokeStaffInviteCode } from '../../../../modules/institutions/institutions'

/** POST /api/v1/invite-codes/:id/revoke — 그 코드 기관의 운영진·운영자(I-02). 200(멱등). 다른 기관 코드 404, 플래그 꺼짐 404. */
export default defineApiHandler((event) => revokeStaffInviteCode(requireDb(), requireActor(event), getRouterParam(event, 'id')))
