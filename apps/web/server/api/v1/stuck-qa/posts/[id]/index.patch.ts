import { setStuckQaContribution } from '../../../../../modules/course-hub/stuck-qa'

/** PATCH /api/v1/stuck-qa/posts/:id {countAsContribution} — 내 답변의 포트폴리오 "후배 기여" 포함 여부(기본 꺼짐). 아니면 404. */
export default defineApiHandler(async (event) =>
  setStuckQaContribution(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
