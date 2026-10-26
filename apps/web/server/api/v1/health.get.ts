import { pingDb } from '@peerchive/db'
import { deepHealth, deepHealthAccess, deletionGraceDays } from '../../modules/ops/health'
import { maintenanceEnabled } from '../../modules/ops/maintenance'
import { publicReadsDisabled } from '../../modules/publication/public-http'

type DbHealth =
  | { status: 'not_configured' }
  | { status: 'ok'; latencyMs: number }
  | { status: 'error' }

/**
 * GET /api/v1/health
 * DATABASE_URL이 설정된 경우에만 `select 1`로 DB를 확인합니다. 점검 모드(PEERCHIVE_MAINTENANCE)에서도 열려 있습니다.
 * `?deep=1`: 운영자만(로그인 안 함 401, 운영자 아님 403 operator_only). 저장소 시험·worker 상태·outbox·작업 실패·삭제 지연(T-16). 항상 200, 판정은 `status`.
 * 오류 메시지·접속 정보는 응답에 싣지 않습니다.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const db = useDb()
  if (getQuery(event).deep !== undefined) {
    if (!db) throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', data: { code: 'db_not_configured' } })
    const access = await deepHealthAccess(db, event.context.auth?.user.id ?? null)
    if (access === 401) throw createError({ statusCode: 401, statusMessage: 'Unauthorized', data: { code: 'unauthenticated' } })
    if (access === 403) throw createError({ statusCode: 403, statusMessage: 'Forbidden', data: { code: 'operator_only' } })
    const result = await deepHealth({
      db,
      storage: useObjectStorage(),
      now: new Date(),
      graceDays: deletionGraceDays(process.env),
      flags: { maintenance: maintenanceEnabled(process.env), publicReadsDisabled: publicReadsDisabled(process.env) },
    })
    // 상세 확인은 항상 200이고 판정은 status 필드(ok/degraded)에 있습니다(운영 화면이 항목별로 보여 줌).
    return result
  }
  let dbHealth: DbHealth = { status: 'not_configured' }

  if (db) {
    const started = performance.now()
    try {
      await pingDb(db)
      dbHealth = { status: 'ok', latencyMs: Math.round(performance.now() - started) }
    } catch {
      dbHealth = { status: 'error' }
    }
  }

  if (dbHealth.status === 'error') {
    setResponseStatus(event, 503)
    return { status: 'degraded' as const, db: dbHealth }
  }
  return { status: 'ok' as const, db: dbHealth }
})
