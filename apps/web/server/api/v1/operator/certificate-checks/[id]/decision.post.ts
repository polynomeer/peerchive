import { decideCertificateCheck } from '../../../../../modules/institutions/certificates'

/** POST /api/v1/operator/certificate-checks/:id/decision {result: approved|rejected} — 운영자만(I-01). 200. 409 already_decided·not_reviewable. */
export default defineApiHandler(async (event) => decideCertificateCheck(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)))
