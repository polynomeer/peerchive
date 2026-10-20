import { adjustCourseTermEndsAt } from '../../../modules/catalog/catalog'

/** PATCH /api/v1/course-terms/:id {endsAt, reason} — 운영자만(아니면 403). 학기 종료 시각 조정(감사 기록). */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return adjustCourseTermEndsAt(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
