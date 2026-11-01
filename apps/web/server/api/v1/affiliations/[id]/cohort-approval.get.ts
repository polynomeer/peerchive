import { getCohortApprovalRequest } from '../../../../modules/institutions/cohort-approvals'

/** GET /api/v1/affiliations/:id/cohort-approval — 승인할 수 있는 같은 기수 멤버에게만(그 밖은 404, I-01). 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => getCohortApprovalRequest(requireDb(), requireActor(event), getRouterParam(event, 'id')))
