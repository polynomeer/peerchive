import { pingDb } from '@peerchive/db'

type DbHealth =
  | { status: 'not_configured' }
  | { status: 'ok'; latencyMs: number }
  | { status: 'error' }

/**
 * GET /api/v1/health
 * DATABASE_URL이 설정된 경우에만 `select 1`로 DB를 확인합니다.
 * 오류 메시지·접속 정보는 응답에 싣지 않습니다.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const db = useDb()
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
