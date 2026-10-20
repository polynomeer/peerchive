import { getReportDetail } from '../../../../../modules/moderation/operator'

/** GET /api/v1/operator/reports/:id — 운영자만. 같은 대상의 신고·공개됐던 내용(신고 때 release 스냅샷 등)·보류·조치 이력. 비공개 과제 공간은 싣지 않습니다. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return getReportDetail(requireDb(), actor, getRouterParam(event, 'id'))
})
