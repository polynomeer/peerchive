import { getInstitutionOverview } from '../../../../../modules/community/institution-pages'

/** GET /api/v1/community/institutions/:id — 기관 운영진·운영자의 기관 운영 화면(I-02). 사람 목록 없음. 403 institution_staff_only, 플래그 꺼짐 404. */
export default defineApiHandler((event) => getInstitutionOverview(requireDb(), requireActor(event), getRouterParam(event, 'id')))
