/**
 * C-03 이름 표시 방식 변경 적용(worker 주기 작업 `name-mode-changes`, 실제 PostgreSQL, rollback).
 * 행은 직접 넣습니다(예약 규칙은 웹 테스트가 봄). 이 테스트가 만든 공간·사용자의 행만 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { NAME_MODE_CHANGE_DELAY_MS } from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  auditEvents,
  communityNotices,
  communitySpaces,
  createDb,
  eq,
  hashSubject,
  inArray,
  nameModeChanges,
  spaceMemberships,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { DEFAULT_CRONS, OPS_TASK_NAMES } from '../src/ops/config'
import { applyDueNameModeChanges, applyNameModeChange } from '../src/ops/name-modes'

const url = process.env.DATABASE_URL
class Rollback extends Error {}
const REQUESTED = new Date('2027-01-05T03:00:00Z')
const EFFECTIVE = new Date(REQUESTED.getTime() + NAME_MODE_CHANGE_DELAY_MS)
const PEPPER = 'test-analytics-pepper-0123456789abcdef'
const id = () => crypto.randomUUID()

describe('name-mode-changes task registration', () => {
  it('runs every minute by default', () => {
    expect(OPS_TASK_NAMES).toContain('name-mode-changes')
    expect(DEFAULT_CRONS['name-mode-changes']).toBe('* * * * *')
  })
})

describe.skipIf(!url)('name mode change apply (PostgreSQL)', () => {
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

  async function user(tx: DbExecutor, name: string, status: 'active' | 'deleted' = 'active') {
    const [row] = await tx.insert(users).values({ displayName: name, privateEmail: `${id()}@example.test`, status }).returning()
    return row!.id
  }

  /** 방장 O·멤버 M(active)·나간 L·내보낸 R·대기 P·탈퇴 요청 D(active 멤버십이지만 계정 deleted)가 있는 실명 방 + 익명으로의 예약. */
  async function world(tx: DbExecutor) {
    const O = await user(tx, '방장')
    const M = await user(tx, '멤버')
    const L = await user(tx, '나간사람')
    const R = await user(tx, '내보낸사람')
    const P = await user(tx, '대기')
    const D = await user(tx, '탈퇴요청', 'deleted')
    const [room] = await tx
      .insert(communitySpaces)
      .values({ kind: 'user_room', name: '실명 동기방', slug: id().replace(/-/g, '').slice(0, 10), currentNameMode: 'real', joinPolicy: 'approval', createdBy: O })
      .returning()
    const joined = new Date('2026-12-01T00:00:00Z')
    await tx.insert(spaceMemberships).values([
      { spaceId: room!.id, userId: O, role: 'owner', status: 'active', joinedAt: joined },
      { spaceId: room!.id, userId: M, role: 'member', status: 'active', joinedAt: joined },
      { spaceId: room!.id, userId: L, role: 'member', status: 'left', joinedAt: joined, endedAt: joined },
      { spaceId: room!.id, userId: R, role: 'member', status: 'removed', joinedAt: joined, endedAt: joined },
      { spaceId: room!.id, userId: P, role: 'member', status: 'pending', requestedAt: joined },
      { spaceId: room!.id, userId: D, role: 'member', status: 'active', joinedAt: joined },
    ])
    const [change] = await tx
      .insert(nameModeChanges)
      .values({ spaceId: room!.id, fromMode: 'real', toMode: 'anonymous', requestedBy: O, requestedAt: REQUESTED, effectiveAt: EFFECTIVE })
      .returning()
    return { O, M, L, R, P, D, room: room!, change: change! }
  }

  const appliedNotices = (tx: DbExecutor, changeId: string) =>
    tx.select().from(communityNotices).where(and(eq(communityNotices.nameModeChangeId, changeId), eq(communityNotices.kind, 'name_mode_applied')))

  it('does nothing before effective_at; applies exactly at effective_at and notifies only active members', async () => {
    await rollback(async (tx) => {
      const w = await world(tx)
      expect(await applyNameModeChange(tx, w.change.id, { now: new Date(EFFECTIVE.getTime() - 1) })).toBeNull()
      const early = await applyDueNameModeChanges(tx, { now: new Date(EFFECTIVE.getTime() - 1) })
      expect(early.applied.find((a) => a.changeId === w.change.id)).toBeUndefined()
      expect((await tx.select().from(communitySpaces).where(eq(communitySpaces.id, w.room.id)))[0]!.currentNameMode).toBe('real')
      expect(await appliedNotices(tx, w.change.id)).toEqual([])

      const result = await applyNameModeChange(tx, w.change.id, { now: EFFECTIVE, analyticsPepper: PEPPER })
      expect(result).toEqual({ changeId: w.change.id, spaceId: w.room.id, notified: 2 })
      const [space] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, w.room.id))
      expect(space!.currentNameMode).toBe('anonymous')
      const [change] = await tx.select().from(nameModeChanges).where(eq(nameModeChanges.id, w.change.id))
      expect(change).toMatchObject({ status: 'applied', appliedAt: EFFECTIVE })
      const notices = await appliedNotices(tx, w.change.id)
      expect(notices.map((n) => n.userId).sort()).toEqual([w.O, w.M].sort())
      expect(notices[0]!.payload).toEqual({ fromMode: 'real', toMode: 'anonymous', effectiveAt: EFFECTIVE.toISOString() })
      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.name_mode_apply'), eq(auditEvents.targetId, w.room.id)))
      expect(audit).toHaveLength(1)
      expect(audit[0]!.metadata).toEqual({ changeId: w.change.id, from: 'real', to: 'anonymous', notified: 2 })
      const events = await tx.select().from(analyticsEvents).where(and(eq(analyticsEvents.name, 'name_mode_applied'), eq(analyticsEvents.actorHash, hashSubject(PEPPER, w.O))))
      expect(events.map((e) => e.props)).toEqual([{ from: 'real', to: 'anonymous' }])
    })
  })

  it('is idempotent: running again (or concurrently re-run) changes nothing and adds no notices', async () => {
    await rollback(async (tx) => {
      const w = await world(tx)
      const later = new Date(EFFECTIVE.getTime() + 60_000)
      const first = await applyDueNameModeChanges(tx, { now: later })
      expect(first.applied.filter((a) => a.changeId === w.change.id)).toHaveLength(1)
      const second = await applyDueNameModeChanges(tx, { now: later })
      expect(second.applied.find((a) => a.changeId === w.change.id)).toBeUndefined()
      expect(await applyNameModeChange(tx, w.change.id, { now: later })).toBeNull()
      expect(await appliedNotices(tx, w.change.id)).toHaveLength(2)
      expect(await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.name_mode_apply'), eq(auditEvents.targetId, w.room.id)))).toHaveLength(1)
    })
  })

  it('never applies cancelled changes; skips analytics when the requester was purged', async () => {
    await rollback(async (tx) => {
      const w = await world(tx)
      await tx.update(nameModeChanges).set({ status: 'cancelled', cancelledAt: REQUESTED, cancelledBy: w.O }).where(eq(nameModeChanges.id, w.change.id))
      expect(await applyNameModeChange(tx, w.change.id, { now: new Date(EFFECTIVE.getTime() + 1) })).toBeNull()
      expect((await tx.select().from(communitySpaces).where(eq(communitySpaces.id, w.room.id)))[0]!.currentNameMode).toBe('real')

      // 새 예약(예약한 사람 없음 = 탈퇴 정리): 적용은 되고 분석 이벤트는 없음.
      const requestedAt = new Date(REQUESTED.getTime() + 1000)
      const [orphan] = await tx
        .insert(nameModeChanges)
        .values({ spaceId: w.room.id, fromMode: 'real', toMode: 'display', requestedBy: null, requestedAt, effectiveAt: new Date(requestedAt.getTime() + NAME_MODE_CHANGE_DELAY_MS) })
        .returning()
      const before = await tx.select().from(analyticsEvents).where(eq(analyticsEvents.name, 'name_mode_applied'))
      expect(await applyNameModeChange(tx, orphan!.id, { now: new Date(requestedAt.getTime() + NAME_MODE_CHANGE_DELAY_MS), analyticsPepper: PEPPER })).toMatchObject({ notified: 2 })
      expect((await tx.select().from(communitySpaces).where(eq(communitySpaces.id, w.room.id)))[0]!.currentNameMode).toBe('display')
      expect(await tx.select().from(analyticsEvents).where(eq(analyticsEvents.name, 'name_mode_applied'))).toHaveLength(before.length)
      // 남은 사람(나감·내보냄·대기·탈퇴 요청)에게는 어떤 알림도 없음
      expect(await tx.select().from(communityNotices).where(inArray(communityNotices.userId, [w.L, w.R, w.P, w.D]))).toEqual([])
    })
  })
})
