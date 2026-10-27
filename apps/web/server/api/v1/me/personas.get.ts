import { listMyPersonas } from '../../../modules/social/personas'

/** GET /api/v1/me/personas — 내 페르소나(실명·표시명)와 표시명 ↔ 실명 연결 플래그(S-01, 본인에게만). */
export default defineApiHandler((event) => listMyPersonas(requireDb(), requireActor(event)))
