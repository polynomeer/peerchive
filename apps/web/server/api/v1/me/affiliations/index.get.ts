import { listMyAffiliations } from '../../../../modules/affiliation/affiliations'

/** GET /api/v1/me/affiliations — 내 학교 인증(만료된 요청 제외)·배지 설정·허브 작성 정책(C-01). */
export default defineApiHandler(async (event) => listMyAffiliations(requireDb(), requireActor(event)))
