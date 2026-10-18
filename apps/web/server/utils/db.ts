import { createDb, type Database } from '@peerchive/db'

let cached: { url: string; db: Database } | undefined

/** 서버 전용 DB 핸들. 접속 문자열이 없으면 null. */
export function useDb(): Database | null {
  const url = useRuntimeConfig().databaseUrl || process.env.DATABASE_URL || ''
  if (!url) return null
  if (!cached || cached.url !== url) cached = { url, db: createDb(url, { connectTimeout: 3 }) }
  return cached.db
}
