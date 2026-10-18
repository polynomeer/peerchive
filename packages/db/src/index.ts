import { sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export { schema }
export * from './schema'

export type Database = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql }

export interface CreateDbOptions {
  /** 커넥션 풀 크기. 기본 10. */
  max?: number
  /** 연결 시도 제한(초). 기본 10. */
  connectTimeout?: number
}

/**
 * PostgreSQL 연결을 만듭니다. 종료할 때는 `await db.$client.end()`를 호출하세요.
 * 접속 문자열은 환경 변수로만 받고 로그·응답에 남기지 않습니다.
 */
export function createDb(url: string, options: CreateDbOptions = {}): Database {
  if (!url) throw new Error('createDb: DATABASE_URL is empty')
  const client = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeout ?? 10,
    onnotice: () => {},
  })
  return drizzle({ client, schema })
}

/** 헬스 체크용 `select 1`. 실패하면 예외를 그대로 던집니다. */
export async function pingDb(db: Database): Promise<void> {
  await db.execute(sql`select 1`)
}
