import { stopUsingAlumniEmail } from '../../../../../modules/affiliation/affiliations'

/** POST /api/v1/me/affiliations/:id/stop-using-email — 졸업생 본인이 학교 메일을 더 쓰지 않음: 읽기만 유지(ADR 0060 D-04). 404, 409 `not_alumni_active`. */
export default defineApiHandler(async (event) => stopUsingAlumniEmail(requireDb(), requireActor(event), getRouterParam(event, 'id')))
