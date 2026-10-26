import { listSchoolEmailDomains } from '../../../../../../modules/affiliation/domains'

/** GET /api/v1/operator/schools/:id/email-domains — 운영자만(403). 그 학교(정본)의 메일 도메인. 404. */
export default defineApiHandler(async (event) => listSchoolEmailDomains(requireDb(), requireActor(event), getRouterParam(event, 'id')))
