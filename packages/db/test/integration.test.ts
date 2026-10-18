/**
 * 실제 PostgreSQL 통합 테스트. DATABASE_URL이 없으면 자동으로 건너뜁니다.
 * migration이 적용된 DB가 필요합니다(`pnpm db:migrate`).
 * 모든 쓰기는 트랜잭션 안에서 하고 마지막에 rollback하므로 데이터가 남지 않습니다.
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb, projectMembers, projects, users, type Database } from '../src'

const url = process.env.DATABASE_URL

class Rollback extends Error {}

/** drizzle가 감싼 오류에서 PostgreSQL SQLSTATE를 찾습니다. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

describe.skipIf(!url)('db integration (PostgreSQL)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined

  afterAll(async () => {
    await db?.$client.end()
  })

  it('enforces one membership per (project_id, user_id)', async () => {
    if (!db) throw new Error('unreachable')
    let duplicateState: string | undefined

    await expect(
      db.transaction(async (tx) => {
        const [alice, bob] = await tx
          .insert(users)
          .values([
            { displayName: 'Alice', privateEmail: `alice+${crypto.randomUUID()}@example.test` },
            { displayName: 'Bob', privateEmail: `bob+${crypto.randomUUID()}@example.test` },
          ])
          .returning({ id: users.id })
        if (!alice || !bob) throw new Error('users not inserted')

        const [project] = await tx
          .insert(projects)
          .values({ ownerId: alice.id, title: '통합 테스트 프로젝트', kind: 'team' })
          .returning({ id: projects.id })
        if (!project) throw new Error('project not inserted')

        await tx.insert(projectMembers).values([
          { projectId: project.id, userId: alice.id, role: 'owner' },
          { projectId: project.id, userId: bob.id, role: 'editor' },
        ])

        // 같은 (project_id, user_id)를 다시 넣으면 거부되어야 합니다. savepoint로 격리합니다.
        try {
          await tx.transaction(async (sp) => {
            await sp.insert(projectMembers).values({ projectId: project.id, userId: bob.id, role: 'viewer' })
          })
        } catch (error) {
          duplicateState = sqlState(error)
        }

        const rows = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, project.id))
        expect(rows).toHaveLength(2)

        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)

    expect(duplicateState).toBe('23505') // unique_violation
  })
})
