import { sql } from 'drizzle-orm'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export { schema }
export * from './schema'

/**
 * 쿼리 연산자 재노출. 앱이 drizzle-orm을 따로 의존하면 peer 조합이 달라 인스턴스가 둘이 될 수 있으므로
 * 이 패키지를 통해서만 씁니다.
 */
export { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'

export type Database = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql }

/**
 * 서비스 함수가 받는 DB 핸들. 최상위 `Database`와 트랜잭션(`tx`)을 모두 받습니다.
 * 트랜잭션 안에서 다시 `transaction()`을 부르면 savepoint가 됩니다(통합 테스트 rollback에 사용).
 */
export type DbExecutor = PgDatabase<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>

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
