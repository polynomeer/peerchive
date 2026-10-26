import { revokeAffiliationByOperator } from '../../../../../modules/affiliation/affiliations'

/** POST /api/v1/operator/affiliations/:id/revoke {reason} — 운영자만(403). 200. 404. 감사 affiliation.revoke. */
export default defineApiHandler(async (event) =>
  revokeAffiliationByOperator(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
