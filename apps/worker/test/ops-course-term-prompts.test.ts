/**
 * E-01 학기 종료 알림(worker 주기 작업 `course-term-prompts`, 실제 PostgreSQL, rollback).
 * 행은 직접 넣습니다(등록 규칙은 웹 테스트가 봄). 이 테스트가 만든 사용자·과목의 행만 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { semesterEndsAt } from '@peerchive/domain'
import {
  courseRegistrations,
  courseTerms,
  courses,
  createDb,
  eq,
  inArray,
  schools,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { DEFAULT_CRONS, OPS_TASK_NAMES } from '../src/ops/config'
import { createPostTermPrompts } from '../src/ops/course-term-prompts'

const url = process.env.DATABASE_URL
class Rollback extends Error {}
const id = () => crypto.randomUUID()
const FALL_END = semesterEndsAt(2026, 'fall')
const BEFORE = new Date(FALL_END.getTime() - 60_000)
const AFTER = new Date(FALL_END.getTime() + 60 * 60 * 1000)

describe('course-term-prompts task registration', () => {
  it('runs hourly by default', () => {
    expect(OPS_TASK_NAMES).toContain('course-term-prompts')
    expect(DEFAULT_CRONS['course-term-prompts']).toBe('53 * * * *')
  })
})

describe.skipIf(!url)('post-term prompts (PostgreSQL)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined
  afterAll(async () => {
    await db?.$client.end()
  })

  async function rollback(fn: (tx: DbExecutor) => Promise<void>) {
    const error = await db!
      .transaction(async (tx) => {
        await fn(tx)
        throw new Rollback()
      })
      .catch((e: unknown) => e)
    if (!(error instanceof Rollback)) throw error
  }

  async function user(tx: DbExecutor, status: 'active' | 'deleted' = 'active') {
    const [row] = await tx.insert(users).values({ displayName: '수강생', privateEmail: `${id()}@example.test`, status }).returning()
    return row!.id
  }

  async function world(tx: DbExecutor) {
    const tag = id().slice(0, 8)
    const [school] = await tx.insert(schools).values({ name: `알림대학${tag}`, nameKey: `promptschool${tag}` }).returning()
    const course = async (n: string) =>
      (await tx.insert(courses).values({ schoolId: school!.id, title: `${n}${tag}`, titleKey: `${n}${tag}` }).returning())[0]!
    const os = await course('os')
    const db2 = await course('db')
    const term = async (courseId: string, year: number, semester: 'fall' | 'winter') =>
      (await tx.insert(courseTerms).values({ courseId, year, semester, endsAt: semesterEndsAt(year, semester) }).returning())[0]!
    const fall = await term(os.id, 2026, 'fall')
    const winter = await term(db2.id, 2026, 'winter')
    // 병합된 학기(정본 = fall)를 가리키는 등록도 정본의 종료 시각으로 판정합니다.
    const merged = (
      await tx.insert(courseTerms).values({ courseId: db2.id, year: 2026, semester: 'fall', endsAt: new Date('2099-01-01T00:00:00Z'), mergedInto: fall.id }).returning()
    )[0]!
    const A = await user(tx)
    const B = await user(tx)
    const D = await user(tx, 'deleted')
    const rows = await tx
      .insert(courseRegistrations)
      .values([
        { userId: A, courseTermId: fall.id },
        { userId: A, courseTermId: winter.id },
        { userId: B, courseTermId: merged.id },
        { userId: D, courseTermId: fall.id },
      ])
      .returning()
    return { rows, ids: rows.map((r) => r.id) }
  }

  const prompted = async (tx: DbExecutor, ids: string[]) =>
    new Map(
      (await tx.select().from(courseRegistrations).where(inArray(courseRegistrations.id, ids))).map((r) => [r.id, r.postTermPromptedAt?.toISOString() ?? null]),
    )

  it('prompts each registration once after its (canonical) term ends, only for active accounts; reruns change nothing (idempotent)', async () => {
    await rollback(async (tx) => {
      const { rows, ids } = await world(tx)
      const [aFall, aWinter, bMerged, dFall] = rows
      await createPostTermPrompts(tx, BEFORE)
      expect([...(await prompted(tx, ids)).values()]).toEqual([null, null, null, null])

      await createPostTermPrompts(tx, AFTER)
      const first = await prompted(tx, ids)
      expect(first.get(aFall!.id)).toBe(AFTER.toISOString())
      expect(first.get(bMerged!.id)).toBe(AFTER.toISOString())
      expect(first.get(aWinter!.id)).toBeNull() // 겨울 계절학기는 아직
      expect(first.get(dFall!.id)).toBeNull() // 탈퇴 요청 계정은 건너뜀

      // 다시 돌려도(같은 시각·나중 시각·작은 배치) 이미 만든 알림은 그대로, 새로 만들 것도 없음.
      const again = await createPostTermPrompts(tx, AFTER)
      expect(again.affected).toBe(0)
      await createPostTermPrompts(tx, new Date(AFTER.getTime() + 60_000), 1)
      expect(await prompted(tx, [aFall!.id, bMerged!.id])).toEqual(new Map([
        [aFall!.id, AFTER.toISOString()],
        [bMerged!.id, AFTER.toISOString()],
      ]))

      // 닫은 알림은 다시 만들지 않습니다.
      await tx.update(courseRegistrations).set({ promptDismissedAt: AFTER }).where(eq(courseRegistrations.id, aFall!.id))
      await createPostTermPrompts(tx, new Date(AFTER.getTime() + 120_000))
      const [row] = await tx.select().from(courseRegistrations).where(eq(courseRegistrations.id, aFall!.id))
      expect(row!.postTermPromptedAt!.toISOString()).toBe(AFTER.toISOString())
      expect(row!.promptDismissedAt!.toISOString()).toBe(AFTER.toISOString())
    })
  })

  it('processes in batches until nothing is due', async () => {
    await rollback(async (tx) => {
      const { ids } = await world(tx)
      const outcome = await createPostTermPrompts(tx, AFTER, 1)
      expect(outcome.batches).toBeGreaterThanOrEqual(2)
      const after = await prompted(tx, ids)
      expect([...after.values()].filter((v) => v !== null)).toHaveLength(2)
    })
  })
})
