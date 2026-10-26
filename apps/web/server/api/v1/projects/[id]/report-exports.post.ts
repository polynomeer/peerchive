import { recordReportExport } from '../../../../modules/contribution/ledger'

/** POST /api/v1/projects/:id/report-exports {from, to} — 리포트 인쇄 표시(분석 이벤트만, T-16). 204. */
export default defineApiHandler(async (event) => {
  await recordReportExport(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event))
  setResponseStatus(event, 204)
  return null
})
