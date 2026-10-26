import { removeSchoolEmailDomain } from '../../../../../../modules/affiliation/domains'

/** DELETE /api/v1/operator/schools/:id/email-domains/:domainId — 운영자만(403). 200. 404. 이미 인증된 소속은 그대로. */
export default defineApiHandler(async (event) =>
  removeSchoolEmailDomain(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'domainId')),
)
