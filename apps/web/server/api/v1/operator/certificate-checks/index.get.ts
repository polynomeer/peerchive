import { listCertificateChecks } from '../../../../modules/institutions/certificates'

/** GET /api/v1/operator/certificate-checks?status=pending|decided — 운영자만(I-01). 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => listCertificateChecks(requireDb(), requireActor(event), getQuery(event)))
