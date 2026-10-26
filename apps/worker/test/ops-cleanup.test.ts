/**
 * T-16 주기 정리 작업(실제 PostgreSQL, rollback). 저장소는 임시 디렉터리입니다.
 * 개발 DB에 다른 행이 있어도 되도록 이 테스트가 만든 행만 확인합니다(개수는 "적어도"로만 봄).
 */
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  affiliationCodes,
  artifactVersions,
  artifacts,
  auditEvents,
  createDb,
  discordChannelBindings,
  discordCodes,
  discordPinRequests,
  eq,
  inArray,
  institutionAffiliations,
  internalRequestNonces,
  magicLinkTokens,
  outboxEvents,
  projects,
  rateLimitBuckets,
  schools,
  sessions,
  sql,
  uploadIntents,
  users,
  workerHeartbeats,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { createFilesystemStorage, newQuarantineKey, type ObjectKey, type ObjectStorage } from '@peerchive/files'
import {
  RETENTION,
  cleanupAffiliationCodes,
  cleanupDiscordCodes,
  cleanupInternalNonces,
  cleanupMagicLinkTokens,
  cleanupOrphanQuarantine,
  cleanupOutbox,
  cleanupPinRequests,
  cleanupRateLimitBuckets,
  cleanupSessions,
  cleanupUploadIntents,
  runRecordedTask,
} from '../src/ops/cleanup'

const url = process.env.DATABASE_URL
class Rollback extends Error {}
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = new Date('2027-03-10T03:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const id = () => crypto.randomUUID()

describe.skipIf(!url)('ops cleanup tasks (PostgreSQL)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined
  let root: string
  let storage: ObjectStorage
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-ops-'))
    storage = createFilesystemStorage(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  afterAll(async () => {
    await db?.$client.end()
  })
  // 작은 배치로 반복을 확인합니다. 개발 DB의 다른 만료 행이 많아도 이 테스트의 행이 먼저 처리되도록 아주 오래된 시각을 씁니다.
  const deps = (batchSize = 2) => ({ storage, batchSize })

  async function rollback(fn: (tx: DbExecutor) => Promise<void>) {
    await expect(
      db!.transaction(async (tx) => {
        await fn(tx)
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  async function userAndProject(tx: DbExecutor) {
    const [user] = await tx.insert(users).values({ displayName: 'ops', privateEmail: `ops+${id()}@example.test` }).returning()
    const [project] = await tx.insert(projects).values({ ownerId: user!.id, title: 'p' }).returning()
    return { userId: user!.id, projectId: project!.id }
  }

  async function putObject(key: ObjectKey, mtime?: Date) {
    await storage.put(key, Readable.from([Buffer.from('x')]), { maxBytes: 10 })
    if (mtime) {
      const [prefix, uuid] = key.split('/') as [string, string]
      await utimes(path.join(root, prefix, uuid.slice(0, 2), uuid), mtime, mtime)
    }
  }

  it('deletes expired upload intents in batches with their unclaimed quarantine files, keeping files a version took over', async () => {
    await rollback(async (tx) => {
      const { userId, projectId } = await userAndProject(tx)
      const intent = (key: string, expiresAt: Date) => ({ projectId, userId, fileName: 'a.png', declaredType: 'image/png', byteSize: 1, quarantineKey: key, expiresAt })
      const keys = [newQuarantineKey(), newQuarantineKey(), newQuarantineKey(), newQuarantineKey()]
      for (const key of keys) await putObject(key)
      const rows = await tx
        .insert(uploadIntents)
        .values([
          intent(keys[0]!, new Date('2000-01-01T00:00:00Z')),
          intent(keys[1]!, new Date('2000-01-01T00:01:00Z')),
          intent(keys[2]!, new Date('2000-01-01T00:02:00Z')),
          intent(keys[3]!, ago(10 * 60 * 1000)),
        ])
        .returning()
      // 셋째 의도는 완료되어 버전이 같은 격리 키를 이어받았습니다(검사 대기).
      const [artifact] = await tx.insert(artifacts).values({ projectId, uploaderId: userId, title: 'a.png' }).returning()
      await tx.insert(artifactVersions).values({
        artifactId: artifact!.id,
        versionNo: 1,
        uploaderId: userId,
        fileName: 'a.png',
        declaredType: 'image/png',
        bytes: 1,
        sha256: 'b'.repeat(64),
        objectKey: keys[2]!,
      })
      const outcome = await cleanupUploadIntents(tx, deps(), NOW)
      expect(outcome.affected).toBeGreaterThanOrEqual(3)
      expect(outcome.batches).toBeGreaterThanOrEqual(2)
      const left = await tx.select({ id: uploadIntents.id }).from(uploadIntents).where(inArray(uploadIntents.id, rows.map((r) => r.id)))
      expect(left.map((r) => r.id)).toEqual([rows[3]!.id])
      expect(await storage.head(keys[0]! as ObjectKey)).toBeNull()
      expect(await storage.head(keys[1]! as ObjectKey)).toBeNull()
      expect(await storage.head(keys[2]! as ObjectKey)).not.toBeNull()
      expect(await storage.head(keys[3]! as ObjectKey)).not.toBeNull()
      // 다시 돌려도 우리 행에는 변화 없음.
      await cleanupUploadIntents(tx, deps(), NOW)
      expect(await tx.select({ id: uploadIntents.id }).from(uploadIntents).where(eq(uploadIntents.id, rows[3]!.id))).toHaveLength(1)
    })
  })

  it('deletes quarantine files older than 24h that no version or intent references', async () => {
    await rollback(async (tx) => {
      const { userId, projectId } = await userAndProject(tx)
      const orphan = newQuarantineKey()
      const fresh = newQuarantineKey()
      const held = newQuarantineKey()
      const pending = newQuarantineKey()
      await putObject(orphan, ago(2 * DAY))
      await putObject(fresh, ago(HOUR))
      await putObject(held, ago(2 * DAY))
      await putObject(pending, ago(2 * DAY))
      await tx.insert(uploadIntents).values({ projectId, userId, fileName: 'x', declaredType: 'image/png', byteSize: 1, quarantineKey: held, expiresAt: NOW })
      const [artifact] = await tx.insert(artifacts).values({ projectId, uploaderId: userId, title: 'x' }).returning()
      await tx.insert(artifactVersions).values({
        artifactId: artifact!.id,
        versionNo: 1,
        uploaderId: userId,
        fileName: 'x',
        declaredType: 'image/png',
        bytes: 1,
        sha256: 'c'.repeat(64),
        objectKey: pending,
      })
      // 다른 파일들이 가려지지 않도록 주인 있는 파일을 많이 두지 않아도 비율 안전장치(50개 초과)에 걸리지 않습니다.
      expect(await cleanupOrphanQuarantine(tx, deps(), NOW)).toMatchObject({ affected: 1, objects: 1 })
      expect(await storage.head(orphan)).toBeNull()
      for (const key of [fresh, held, pending]) expect(await storage.head(key)).not.toBeNull()
    })
  })

  it('halts the orphan sweep when most files look unowned (worker pointed at the wrong database)', async () => {
    await rollback(async (tx) => {
      const keys = Array.from({ length: 60 }, () => newQuarantineKey())
      for (const key of keys) await putObject(key, ago(2 * DAY))
      expect(await cleanupOrphanQuarantine(tx, deps(), NOW)).toMatchObject({ affected: 0, halted: 'orphan_ratio_too_high' })
      expect(await storage.head(keys[0]!)).not.toBeNull()
    })
  })

  it('deletes rate limit buckets older than two max windows, stale nonces, old magic links, expired sessions and old discord codes', async () => {
    await rollback(async (tx) => {
      const { userId, projectId } = await userAndProject(tx)
      const tag = id()
      await tx.insert(rateLimitBuckets).values([
        { key: `old:${tag}`, windowStart: ago(2 * RETENTION.rateLimitMaxWindowMs + HOUR), count: 1 },
        { key: `new:${tag}`, windowStart: ago(HOUR), count: 1 },
      ])
      await tx.insert(internalRequestNonces).values([
        { nonce: `old-${tag}`, receivedAt: ago(HOUR) },
        { nonce: `new-${tag}`, receivedAt: ago(60 * 1000) },
      ])
      const email = `ml+${tag}@example.test`
      await tx.insert(magicLinkTokens).values([
        { email, tokenHash: `used-old-${tag}`, expiresAt: ago(8 * DAY), usedAt: ago(8 * DAY), createdAt: ago(8 * DAY) },
        { email, tokenHash: `expired-old-${tag}`, expiresAt: ago(8 * DAY), createdAt: ago(8 * DAY) },
        { email, tokenHash: `used-recent-${tag}`, expiresAt: ago(HOUR), usedAt: ago(HOUR), createdAt: ago(2 * HOUR) },
        { email, tokenHash: `live-${tag}`, expiresAt: new Date(NOW.getTime() + HOUR), createdAt: ago(60 * 1000) },
      ])
      await tx.insert(sessions).values([
        { id: `old-${tag}`, secretHash: 'x', userId, expiresAt: ago(60 * 1000) },
        { id: `live-${tag}`, secretHash: 'x', userId, expiresAt: new Date(NOW.getTime() + DAY) },
      ])
      await tx.insert(discordCodes).values([
        { kind: 'link', codeHash: `used-${tag}`, userId, expiresAt: ago(2 * DAY), usedAt: ago(2 * DAY) },
        { kind: 'bind', codeHash: `expired-${tag}`, userId, projectId, expiresAt: ago(2 * DAY) },
        { kind: 'link', codeHash: `live-${tag}`, userId, expiresAt: new Date(NOW.getTime() + 60 * 1000) },
      ])

      // 한 실행의 최대 행 수(배치 × 50)가 개발 DB에 남은 다른 만료 행보다 크도록 큰 배치를 씁니다.
      for (const task of [cleanupRateLimitBuckets, cleanupInternalNonces, cleanupMagicLinkTokens, cleanupSessions, cleanupDiscordCodes]) {
        expect((await task(tx, deps(10_000), NOW)).affected).toBeGreaterThanOrEqual(1)
      }
      const keys = (await tx.select({ key: rateLimitBuckets.key }).from(rateLimitBuckets).where(sql`${rateLimitBuckets.key} like ${`%:${tag}`}`)).map((r) => r.key)
      expect(keys).toEqual([`new:${tag}`])
      expect((await tx.select().from(internalRequestNonces).where(sql`${internalRequestNonces.nonce} like ${`%-${tag}`}`)).map((r) => r.nonce)).toEqual([`new-${tag}`])
      expect((await tx.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))).map((r) => r.tokenHash).sort()).toEqual(
        [`live-${tag}`, `used-recent-${tag}`].sort(),
      )
      expect((await tx.select().from(sessions).where(eq(sessions.userId, userId))).map((r) => r.id)).toEqual([`live-${tag}`])
      expect((await tx.select().from(discordCodes).where(eq(discordCodes.userId, userId))).map((r) => r.codeHash)).toEqual([`live-${tag}`])
    })
  })

  it('expires school-mail requests with no usable code left (dropping the email hash) and deletes old codes, leaving active rows alone', async () => {
    await rollback(async (tx) => {
      const { userId } = await userAndProject(tx)
      const hex = () => id().replace(/-/g, '').repeat(2)
      const newSchool = async () => (await tx.insert(schools).values({ name: `학교 ${id()}`, nameKey: `s-${id()}` }).returning())[0]!.id
      const base = { userId, emailHash: '', emailDomain: 'u.ac.kr', standing: 'student' as const }
      const [stale, locked, fresh, active] = await tx
        .insert(institutionAffiliations)
        .values([
          { ...base, schoolId: await newSchool(), emailHash: hex(), status: 'pending' },
          { ...base, schoolId: await newSchool(), emailHash: hex(), status: 'pending' },
          { ...base, schoolId: await newSchool(), emailHash: hex(), status: 'pending' },
          { ...base, schoolId: await newSchool(), emailHash: hex(), status: 'active', verifiedAt: ago(10 * DAY) },
        ])
        .returning()
      const [, , freshCode, usedOld] = await tx
        .insert(affiliationCodes)
        .values([
          { affiliationId: stale!.id, codeHash: hex(), expiresAt: ago(2 * HOUR), createdAt: ago(3 * HOUR) },
          { affiliationId: locked!.id, codeHash: hex(), expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000), attempts: 5 },
          { affiliationId: fresh!.id, codeHash: hex(), expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000) },
          { affiliationId: active!.id, codeHash: hex(), expiresAt: ago(10 * DAY), usedAt: ago(10 * DAY) },
        ])
        .returning()
      // 잠긴 코드는 유예 1시간 기준으로 보지 않고(쓸 수 없음) 바로 만료 대상입니다.
      expect((await cleanupAffiliationCodes(tx, deps(10_000), NOW)).affected).toBeGreaterThanOrEqual(3)
      const rows = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.userId, userId))
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get(stale!.id)).toMatchObject({ status: 'expired', emailHash: null })
      expect(byId.get(locked!.id)).toMatchObject({ status: 'expired', emailHash: null })
      expect(byId.get(fresh!.id)).toMatchObject({ status: 'pending' })
      expect(byId.get(fresh!.id)!.emailHash).not.toBeNull()
      expect(byId.get(active!.id)).toMatchObject({ status: 'active' })
      const codes = await tx.select({ id: affiliationCodes.id }).from(affiliationCodes).where(inArray(affiliationCodes.affiliationId, rows.map((r) => r.id)))
      expect(codes.map((c) => c.id)).not.toContain(usedOld!.id)
      expect(codes.map((c) => c.id)).toContain(freshCode!.id)
    })
  })

  it('expires overdue pin requests and clears their stored message content; deletes old dispatched outbox rows only', async () => {
    await rollback(async (tx) => {
      const { userId, projectId } = await userAndProject(tx)
      const [binding] = await tx.insert(discordChannelBindings).values({ projectId, guildId: 'g', channelId: `c-${id()}`, boundBy: userId }).returning()
      const pin = (status: 'pending', expiresAt: Date) => ({
        bindingId: binding!.id,
        messageId: `m-${id()}`,
        channelId: 'c',
        authorExternalId: 'a',
        authorUserId: userId,
        requesterUserId: userId,
        content: '메시지 본문',
        status,
        expiresAt,
      })
      const [overdue, live] = await tx.insert(discordPinRequests).values([pin('pending', ago(HOUR)), pin('pending', new Date(NOW.getTime() + HOUR))]).returning()
      expect((await cleanupPinRequests(tx, deps(), NOW)).affected).toBeGreaterThanOrEqual(1)
      const [a] = await tx.select().from(discordPinRequests).where(eq(discordPinRequests.id, overdue!.id))
      const [b] = await tx.select().from(discordPinRequests).where(eq(discordPinRequests.id, live!.id))
      expect(a).toMatchObject({ status: 'expired', content: null })
      expect(b).toMatchObject({ status: 'pending', content: '메시지 본문' })

      const rows = await tx
        .insert(outboxEvents)
        .values([
          { topic: 'ops-test', payload: {}, createdAt: ago(40 * DAY), dispatchedAt: ago(31 * DAY) },
          { topic: 'ops-test', payload: {}, createdAt: ago(40 * DAY), dispatchedAt: ago(DAY) },
          { topic: 'ops-test', payload: {}, createdAt: ago(40 * DAY), dispatchedAt: null },
        ])
        .returning()
      expect((await cleanupOutbox(tx, deps(10_000), NOW)).affected).toBeGreaterThanOrEqual(1)
      const left = await tx.select({ id: outboxEvents.id }).from(outboxEvents).where(inArray(outboxEvents.id, rows.map((r) => r.id)))
      expect(left.map((r) => r.id).sort()).toEqual([rows[1]!.id, rows[2]!.id].sort())
    })
  })

  it('records each run in worker_heartbeats and as an ops.cleanup audit event with counts only', async () => {
    await rollback(async (tx) => {
      const outcome = await runRecordedTask(tx, 'sessions', async () => ({ affected: 3, batches: 1 }))
      expect(outcome.affected).toBe(3)
      const [hb] = await tx.select().from(workerHeartbeats).where(eq(workerHeartbeats.name, 'task:sessions'))
      expect(hb!.details).toMatchObject({ status: 'ok', affected: 3, batches: 1 })
      const [audit] = await tx
        .select()
        .from(auditEvents)
        .where(sql`${auditEvents.action} = 'ops.cleanup' and ${auditEvents.metadata}->>'task' = 'sessions'`)
        .orderBy(sql`${auditEvents.at} desc`)
        .limit(1)
      expect(audit!.metadata).toMatchObject({ task: 'sessions', affected: 3 })
      await expect(runRecordedTask(tx, 'outbox', async () => Promise.reject(Object.assign(new Error('x'), { code: '57014' })))).rejects.toThrow()
      const [failed] = await tx.select().from(workerHeartbeats).where(eq(workerHeartbeats.name, 'task:outbox'))
      expect(failed!.details).toEqual({ status: 'error', error: '57014' })
    })
  })
})
