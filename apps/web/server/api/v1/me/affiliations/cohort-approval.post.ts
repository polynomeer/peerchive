import { requestCohortApproval } from '../../../../modules/institutions/cohort-approvals'

/** POST /api/v1/me/affiliations/cohort-approval {institutionId, cohortLabel, standing} — 기수 승인 요청(I-01). 201 + pending. 플래그가 꺼져 있으면 404. */
export default defineApiHandler(async (event) => {
  const result = await requestCohortApproval(requireDb(), requireActor(event), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
