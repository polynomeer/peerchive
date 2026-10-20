import { addSnapshot } from '../../../../../modules/milestones/milestones'

/**
 * POST /api/v1/milestones/:id/snapshots {artifactVersionId, note?} — owner/editor. 같은 프로젝트의 clean 버전만.
 * 201 + 갱신된 마일스톤. clean 아님 422 not_clean, 다른 프로젝트·없음 422 not_found, 중복 409 duplicate.
 */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  const milestone = await addSnapshot(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return milestone
})
