import { getCompletionRetroComposer } from '../../../../modules/institutions/completion-retros'

/** GET /api/v1/me/completion-retros/composer — 수료 회고 쓰기 화면(A-06): 쓸 수 있는 내 수료생 소속·익명 기관 표시 미리보기. 플래그 꺼짐 404. */
export default defineApiHandler(async (event) => getCompletionRetroComposer(requireDb(), requireActor(event)))
