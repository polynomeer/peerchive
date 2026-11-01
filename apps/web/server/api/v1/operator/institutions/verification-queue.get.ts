import { getVerificationQueue } from '../../../../modules/institutions/verification-queue'

/** GET /api/v1/operator/institutions/verification-queue — 기관 인증 수단별 처리 큐(A-07). 운영자만, institutions 플래그가 꺼져 있으면 404. */
export default defineApiHandler((event) => getVerificationQueue(requireDb(), requireActor(event)))
