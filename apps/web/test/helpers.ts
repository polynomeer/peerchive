/**
 * 서비스 통합 테스트 도우미. DATABASE_URL이 없으면 통합 테스트는 건너뜁니다.
 * 각 테스트는 바깥 트랜잭션 안에서 실행하고 마지막에 rollback하므로 데이터가 남지 않습니다
 * (서비스 안의 transaction()은 savepoint가 됩니다).
 */
import { expect } from 'vitest'
import { createDb, institutionAffiliations, personas, profiles, users, type Database, type DbExecutor } from '@peerchive/db'
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
  if (overrides.handle) await insertRealProfile(db, user.id, overrides.handle)
  return { id: user.id, email }
}

/** 실명 페르소나 + 프로필 fixture(S-01: 프로필은 페르소나에 붙고, handle의 원본은 페르소나 행). */
export async function insertRealProfile(db: DbExecutor, userId: string, handle: string): Promise<{ personaId: string }> {
  const [persona] = await db.insert(personas).values({ userId, kind: 'real', handle }).returning({ id: personas.id })
  if (!persona) throw new Error('persona not inserted')
  await db.insert(profiles).values({ personaId: persona.id, personaKind: 'real', userId, handle })
  return { personaId: persona.id }
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

/**
 * 학교 메일 인증 fixture(C-01): 그 학교의 active 소속을 바로 넣습니다(코드 흐름 자체는 affiliation.integration.test.ts).
 * 과목 허브에 선배 노트를 쓰는 테스트가 씁니다. 메일 해시는 무작위 값입니다.
 */
export async function verifiedAffiliation(
  db: DbExecutor,
  userId: string,
  schoolId: string,
  overrides: { standing?: 'student' | 'alumni'; departmentLabel?: string | null; verifiedAt?: Date } = {},
): Promise<{ id: string }> {
  const [row] = await db
    .insert(institutionAffiliations)
    .values({
      userId,
      schoolId,
      emailHash: crypto.randomUUID().replace(/-/g, '').repeat(2),
      emailDomain: 'fixture.ac.kr',
      standing: overrides.standing ?? 'student',
      departmentLabel: overrides.departmentLabel ?? null,
      status: 'active',
      verifiedAt: overrides.verifiedAt ?? new Date('2026-09-01T00:00:00Z'),
    })
    .returning({ id: institutionAffiliations.id })
  if (!row) throw new Error('affiliation not inserted')
  return row
}
