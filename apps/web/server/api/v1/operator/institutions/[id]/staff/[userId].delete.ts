import { revokeInstitutionStaff } from '../../../../../../modules/institutions/staff'

/** DELETE /api/v1/operator/institutions/:id/staff/:userId — 운영자만(I-02). 운영진 해제(행은 남김). 감사 id만. 플래그 꺼짐 404. */
export default defineApiHandler((event) => revokeInstitutionStaff(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'userId')))
