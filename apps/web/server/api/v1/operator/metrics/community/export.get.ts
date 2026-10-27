import { exportCommunityMetricsCsv } from '../../../../../modules/community/ops-metrics'

/**
 * GET /api/v1/operator/metrics/community/export?from=&to= — 운영자만(403 operator_only). 집계 CSV(id·이름·글·공간별 값 없음, 5 미만 빈 칸).
 * 운영자마다 시간당 10회(429), 감사 metrics.export. no-store·noindex.
 */
export default defineApiHandler(async (event) => {
  const { csv, filename } = await exportCommunityMetricsCsv(requireDb(), requireActor(event), getQuery(event))
  setResponseHeaders(event, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  })
  return csv
})
