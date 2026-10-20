import { removeSnapshot } from '../../../../../modules/milestones/milestones'

/** DELETE /api/v1/milestones/:id/snapshots/:artifactVersionId — owner/editor. 지정되지 않은 버전은 404. 204. */
export default defineApiHandler(async (event) => {
  await removeSnapshot(
    requireDb(),
    requireActor(event),
    getRouterParam(event, 'id'),
    getRouterParam(event, 'artifactVersionId'),
  )
  setResponseStatus(event, 204)
  return null
})
