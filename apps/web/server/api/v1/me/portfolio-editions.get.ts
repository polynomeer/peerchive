import { listMyEditions } from '../../../modules/portfolio/editions'

/** GET /api/v1/me/portfolio-editions — 내 포트폴리오 판 전체(지금 판 표시, 이전 판은 공개하지 않음). */
export default defineApiHandler((event) => listMyEditions(requireDb(), requireActor(event)))
