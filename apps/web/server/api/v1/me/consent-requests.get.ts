import { listMyConsentRequests } from '../../../modules/publication/candidates'

/** GET /api/v1/me/consent-requests — 내가 결정할 대기 중 동의 요청(열린 후보만). */
export default defineApiHandler(async (event) => listMyConsentRequests(requireDb(), requireActor(event)))
