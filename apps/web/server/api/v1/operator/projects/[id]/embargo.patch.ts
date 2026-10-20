import { lowerProjectEmbargo } from '../../../../../modules/embargo/embargo'

/**
 * PATCH /api/v1/operator/projects/:id/embargo {until|null, reason} — 운영자만(403). 엠바고 낮추기(감사 기록).
 * 응답은 적용 엠바고뿐이며 프로젝트 내용은 싣지 않습니다.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return lowerProjectEmbargo(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
