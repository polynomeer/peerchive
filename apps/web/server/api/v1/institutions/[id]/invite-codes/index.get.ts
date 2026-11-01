import { listStaffInviteCodes } from '../../../../../modules/institutions/institutions'

/** GET /api/v1/institutions/:id/invite-codes — 그 기관 운영진·운영자(I-02). 원문 없이 목록. 403 institution_staff_only, 플래그 꺼짐 404. */
export default defineApiHandler((event) => listStaffInviteCodes(requireDb(), requireActor(event), getRouterParam(event, 'id')))
