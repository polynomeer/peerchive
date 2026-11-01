import { operatorStuckQaAuthor } from '../../../../../../modules/course-hub/stuck-qa'

/**
 * POST /api/v1/operator/stuck-qa/posts/:id/author-lookup {reportId} — 운영자만. 그 글을 가리키는 신고에 묶인 작성자 확인(감사 stuck_qa.author_lookup).
 * 작성자는 이 응답에만 있습니다. 신고가 그 글을 가리키지 않으면 404.
 */
export default defineApiHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return operatorStuckQaAuthor(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
})
