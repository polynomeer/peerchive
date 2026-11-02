import { approveMeetingDraft } from '../../../../../../../modules/ai/meeting-summary'

/**
 * POST /api/v1/projects/:id/ai-meetings/drafts/:draftId/approve {body?, payload?, links?, claimedDate?, milestoneId?, tasks?: [{title, assigneeId?, dueAt?}]}
 * — 회의 요약 초안을 (고친 내용으로) 승인해 🗣️ 회의 로그(source ai, `AI 초안`)와 고른 할 일을 만듭니다. 201.
 * 403 second_approver_required(요청자 본인 — 다른 owner/editor가 승인), 403 권한, 404 없는 초안·만료, 422 검증.
 */
export default defineApiHandler(async (event) => {
  const result = await approveMeetingDraft(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'draftId'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
