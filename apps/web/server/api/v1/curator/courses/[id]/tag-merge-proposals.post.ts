import { proposeTagMerge } from '../../../../../modules/curators/tag-proposals'

/** POST /api/v1/curator/courses/:id/tag-merge-proposals {sourceTagId, targetTagId, note?} — 그 과목 큐레이터만(E-03). 201. 409 already_proposed, 422, 429. */
export default defineApiHandler(async (event) => {
  const result = await proposeTagMerge(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
