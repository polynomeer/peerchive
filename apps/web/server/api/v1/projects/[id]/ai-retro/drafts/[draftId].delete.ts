import { discardAiRetroDraft } from '../../../../../../modules/ai/retro-interview'

/** DELETE /api/v1/projects/:id/ai-retro/drafts/:draftId — 본인 초안 버리기(로그를 쓰지 않음). */
export default defineApiHandler((event) =>
  discardAiRetroDraft(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'draftId')),
)
