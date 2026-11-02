import { setMeetingConsent } from '../../../../../../../modules/ai/meeting-summary'

/** PUT /api/v1/projects/:id/ai-meetings/channels/:bindingId/consent {agree} — 멤버 본인의 요약 동의·철회(철회하면 즉시 요약 중단, 그 채널의 승인 전 초안 삭제). */
export default defineApiHandler(async (event) =>
  setMeetingConsent(requireDb(), requireActor(event), getRouterParam(event, 'id'), getRouterParam(event, 'bindingId'), await readJsonBody(event)),
)
