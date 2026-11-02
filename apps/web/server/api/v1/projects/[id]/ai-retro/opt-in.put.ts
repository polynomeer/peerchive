import { setAiRetroOptIn } from '../../../../../modules/ai/retro-interview'

/** PUT /api/v1/projects/:id/ai-retro/opt-in {enabled} — 이 과제에서 AI 회고 인터뷰 켜기·끄기(본인, owner/editor). 끄면 세션·초안을 지웁니다. */
export default defineApiHandler(async (event) =>
  setAiRetroOptIn(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
