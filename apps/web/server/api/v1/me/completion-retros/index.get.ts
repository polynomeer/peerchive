import { listMyCompletionRetros } from '../../../../modules/institutions/completion-retros'

/** GET /api/v1/me/completion-retros — 내 수료 회고(모든 상태, A-06, P2 institutions 플래그, 꺼짐 404). */
export default defineApiHandler(async (event) => listMyCompletionRetros(requireDb(), requireActor(event)))
