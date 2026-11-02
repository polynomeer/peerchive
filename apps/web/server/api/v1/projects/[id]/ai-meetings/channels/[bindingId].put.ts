import { setMeetingChannel } from '../../../../../../modules/ai/meeting-summary'

/** PUT /api/v1/projects/:id/ai-meetings/channels/:bindingId {enabled} — owner가 연결된 채널을 회의 채널로 제안하거나 거둠(거두면 동의·초안 삭제). */
export default defineApiHandler(async (event) =>
  setMeetingChannel(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'bindingId'), await readJsonBody(event)),
)
