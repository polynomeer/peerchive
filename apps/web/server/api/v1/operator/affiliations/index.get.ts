import { listAffiliationsForOperator } from '../../../../modules/affiliation/affiliations'

/** GET /api/v1/operator/affiliations?schoolId=|userId=&status= — 운영자만(403). 사용자 id·학교·도메인·상태만(메일·학과 없음). */
export default defineApiHandler(async (event) => listAffiliationsForOperator(requireDb(), requireActor(event), getQuery(event)))
