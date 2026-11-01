import { withdrawCompletionRetro } from '../../../../../modules/institutions/completion-retros'

/** POST /api/v1/me/completion-retros/:id/withdraw — 작성자만(아니면 404), 즉시 목록에서 빠짐. 이미 철회 200. 플래그 꺼짐 404. */
export default defineApiHandler(async (event) => withdrawCompletionRetro(requireDb(), requireActor(event), getRouterParam(event, 'id')))
