import { mergeSchool } from '../../../../../modules/catalog/merge'

/** POST /api/v1/operator/schools/:id/merge {into} — 운영자만(403). 200 + 정본 학교. 이미 병합 409. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return mergeSchool(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
