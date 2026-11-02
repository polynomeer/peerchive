import { approveAiRetroDraft } from '../../../../../../../modules/ai/retro-interview'

/**
 * POST /api/v1/projects/:id/ai-retro/drafts/:draftId/approve {body?, payload?, links?, claimedDate?, milestoneId?, evidenceVersionIds?}
 * — 본인 초안을 (고친 내용으로) 승인해 빌드 로그를 만듭니다(source ai, `AI 초안`). 201. 남의 초안·없는 초안은 404, 검증 422, 편집 권한 403.
 */
export default defineApiHandler(async (event) => {
  const result = await approveAiRetroDraft(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'draftId'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
