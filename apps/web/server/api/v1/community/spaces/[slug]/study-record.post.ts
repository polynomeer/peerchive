import { enableStudyRecord } from '../../../../../modules/community/study-records'

/**
 * POST /api/v1/community/spaces/:slug/study-record {courseTermId?} — 스터디 기록 켜기(스터디 방의 방장만, C-08).
 * 201. 403(방장 아님·write_restricted), 404, 409 not_study_room·space_not_active·already_enabled, 422 courseTermId.
 */
export default defineApiHandler(async (event) => {
  const result = await enableStudyRecord(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event))
  setResponseStatus(event, 201)
  return result
})
