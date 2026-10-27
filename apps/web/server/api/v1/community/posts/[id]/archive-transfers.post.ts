import { createArchiveTransfer } from '../../../../../modules/community/archive-transfers'
import { readCommunityWriteBody } from '../../../../../modules/community/http'

/**
 * POST /api/v1/community/posts/:id/archive-transfers {target, courseId?, projectId?, includeAnswer?, displayMode?, displayName?, timeBucket?,
 * notAnswerConfirmed?, answerKey?, noAnswersConfirmed?, confirmWarnings?} — 아카이브로 옮기기 요청(C-09). **201** + 요청.
 * 403 not_author·hub_write_not_allowed·write_restricted, 404, 409 source_not_open·not_question_board·no_accepted_answer·transfer_pending·
 * already_transferred·space_not_active·checks_unconfirmed·limit_reached, 422, 429.
 */
export default defineApiHandler(async (event) => {
  const result = await createArchiveTransfer(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readCommunityWriteBody(event))
  setResponseStatus(event, 201)
  return result
})
