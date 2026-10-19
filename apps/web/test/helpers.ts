/**
 * 서비스 통합 테스트 도우미. DATABASE_URL이 없으면 통합 테스트는 건너뜁니다.
 * 각 테스트는 바깥 트랜잭션 안에서 실행하고 마지막에 rollback하므로 데이터가 남지 않습니다
 * (서비스 안의 transaction()은 savepoint가 됩니다).
 */
import { expect } from 'vitest'
import { createDb, profiles, users, type Database, type DbExecutor } from '@peerchive/db'
import { ServiceError, type ServiceErrorCode } from '../server/modules/errors'

export const databaseUrl = process.env.DATABASE_URL

let shared: Database | undefined
export function testDb(): Database {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')
  shared ??= createDb(databaseUrl, { max: 2 })
  return shared
}

export async function closeTestDb(): Promise<void> {
  await shared?.$client.end()
  shared = undefined
}

class Rollback extends Error {}

export async function withRollback(fn: (tx: DbExecutor) => Promise<void>): Promise<void> {
  await expect(
    testDb().transaction(async (tx) => {
      await fn(tx)
      throw new Rollback()
    }),
  ).rejects.toBeInstanceOf(Rollback)
}

export const uniqueEmail = (label = 'user') => `${label}+${crypto.randomUUID()}@example.test`

export async function createUser(
  db: DbExecutor,
  overrides: { status?: 'active' | 'suspended' | 'deleted'; displayName?: string; handle?: string } = {},
): Promise<{ id: string; email: string }> {
  const email = uniqueEmail()
  const [user] = await db
    .insert(users)
    .values({ displayName: overrides.displayName ?? '테스트 사용자', privateEmail: email, status: overrides.status ?? 'active' })
    .returning({ id: users.id })
  if (!user) throw new Error('user not inserted')
  if (overrides.handle) await db.insert(profiles).values({ userId: user.id, handle: overrides.handle })
  return { id: user.id, email }
}

/** 서비스 오류 코드(와 이유)를 확인합니다. */
export async function expectServiceError(
  promise: Promise<unknown>,
  code: ServiceErrorCode,
  reason?: string,
): Promise<ServiceError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ServiceError ${code}`)
    },
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ServiceError)
  const serviceError = error as ServiceError
  expect(serviceError.code).toBe(code)
  if (reason) expect(serviceError.reason).toBe(reason)
  return serviceError
}

export const minutes = (n: number) => n * 60 * 1000
export const days = (n: number) => n * 24 * 60 * 60 * 1000
