import { setAnalyticsOptOut } from '../../../modules/analytics/analytics'

/** PATCH /api/v1/me/preferences {analyticsOptOut} — pilot 분석 수집 거부/허용(T-16). 거부하면 지난 이벤트도 지웁니다. */
export default defineApiHandler(async (event) => setAnalyticsOptOut(requireDb(), requireActor(event), await readJsonBody(event)))
