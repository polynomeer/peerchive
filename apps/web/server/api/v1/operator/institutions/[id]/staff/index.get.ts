import { listInstitutionStaff } from '../../../../../../modules/institutions/staff'

/** GET /api/v1/operator/institutions/:id/staff — 운영자만(I-02). 지금 기관 운영진. 플래그 꺼짐 404. */
export default defineApiHandler((event) => listInstitutionStaff(requireDb(), requireActor(event), getRouterParam(event, 'id')))
