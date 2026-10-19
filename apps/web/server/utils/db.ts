import { createDb, type Database } from '@peerchive/db'

let cached: { url: string; db: Database } | undefined

/** 서버 전용 DB 핸들. 접속 문자열이 없으면 null. */
export function useDb(): Database | null {
  const url = useRuntimeConfig().databaseUrl || process.env.DATABASE_URL || ''
  if (!url) return null
  if (!cached || cached.url !== url) cached = { url, db: createDb(url, { connectTimeout: 3 }) }
  return cached.db
}

/** DB가 꼭 필요한 API용. 설정이 없으면 503(접속 정보는 응답에 싣지 않음). */
export function requireDb(): Database {
  const db = useDb()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', data: { code: 'db_not_configured' } })
  return db
}
