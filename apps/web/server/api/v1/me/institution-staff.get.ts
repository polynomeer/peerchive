import { listMyStaffInstitutions } from '../../../modules/institutions/staff'

/** GET /api/v1/me/institution-staff — 내가 운영진인 기관(I-02, ADR 0044). 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => listMyStaffInstitutions(requireDb(), requireActor(event)))
