import { listReportGroups } from '../../../../modules/moderation/operator'

/** GET /api/v1/operator/reports?status=open|in_review|resolved|dismissed — 운영자만(403 operator_only). 대상별 묶음. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return listReportGroups(requireDb(), actor, getQuery(event))
})
