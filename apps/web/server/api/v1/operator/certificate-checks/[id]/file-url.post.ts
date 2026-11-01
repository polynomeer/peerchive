import { certificateFileUrl } from '../../../../../modules/institutions/certificates'

/** POST /api/v1/operator/certificate-checks/:id/file-url — 운영자만, 결정 전·검사 통과일 때 60초 서명 URL(I-01). 그 밖은 404. */
export default defineApiHandler((event) => certificateFileUrl(requireDb(), requireActor(event), getRouterParam(event, 'id')))
