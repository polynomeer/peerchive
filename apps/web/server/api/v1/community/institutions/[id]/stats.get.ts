import { getInstitutionStats } from '../../../../../modules/community/institution-pages'

/** GET /api/v1/community/institutions/:id/stats — 운영진·운영자(I-02). 집계만, 모든 칸 5 미만 null. 403 institution_staff_only, 플래그 꺼짐 404. */
export default defineApiHandler((event) => getInstitutionStats(requireDb(), requireActor(event), getRouterParam(event, 'id')))
