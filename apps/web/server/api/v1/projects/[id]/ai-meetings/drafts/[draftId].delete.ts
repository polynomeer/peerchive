import { rejectMeetingDraft } from '../../../../../../modules/ai/meeting-summary'

/** DELETE /api/v1/projects/:id/ai-meetings/drafts/:draftId — 회의 요약 초안 거절(owner/editor, 로그·할 일을 쓰지 않음). */
export default defineApiHandler((event) =>
  rejectMeetingDraft(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'draftId')),
)
