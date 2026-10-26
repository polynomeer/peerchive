import { addSchoolEmailDomain } from '../../../../../../modules/affiliation/domains'

/**
 * POST /api/v1/operator/schools/:id/email-domains {domain} — 운영자만(403). 201(이미 그 학교에 있으면 200 created: false).
 * 422 domain invalid·shared_suffix·webmail, 409 domain_taken·domain_overlaps, 404.
 */
export default defineApiHandler(async (event) => {
  const result = await addSchoolEmailDomain(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, result.created ? 201 : 200)
  return result
})
