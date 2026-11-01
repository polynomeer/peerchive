/**
 * I-01 수료증 파일 삭제(`certificate-files`)·삭제 장부(source retention)·재적용, 그리고 기관 인증 수단 행의 정리 규칙
 * (격리 파일 정리·인증 코드 정리·탈퇴 정리). 실제 PostgreSQL, rollback. 저장소는 임시 디렉터리입니다.
 */
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  and,
  certificateChecks,
  cohortApprovals,
  createDb,
  deletionLedger,
  eq,
  hashSubject,
  inArray,
  institutionAffiliations,
  institutionCohorts,
  schools,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { createFilesystemStorage, newQuarantineKey, type ObjectKey, type ObjectStorage } from '@peerchive/files'
import { CERTIFICATE_LEDGER_KIND, purgeCertificateFiles } from '../src/ops/certificates'
import { cleanupAffiliationCodes, cleanupOrphanQuarantine } from '../src/ops/cleanup'
import { exportLedger, reapplyDeletions } from '../src/ops/ledger'
import { purgeAccount } from '../src/ops/purge'

const url = process.env.DATABASE_URL
class Rollback extends Error {}
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = new Date('2027-04-01T03:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const id = () => crypto.randomUUID()
const DELETION_PEPPER = 'test-deletion-pepper-0123456789abcdef'

describe.skipIf(!url)('certificate files and institution rows (PostgreSQL, I-01)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined
  let root: string
  let storage: ObjectStorage
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-certs-'))
    storage = createFilesystemStorage(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  afterAll(async () => {
    await db?.$client.end()
  })
  const deps = () => ({ storage, deletionPepper: DELETION_PEPPER, batchSize: 500 })
  const purgeDeps = () => ({ storage, deletionPepper: DELETION_PEPPER, analyticsPepper: null })

  async function rollback(fn: (tx: DbExecutor) => Promise<void>) {
    await expect(
      db!.transaction(async (tx) => {
        await fn(tx)
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  async function user(tx: DbExecutor, status: 'active' | 'deleted' = 'active') {
    const [row] = await tx.insert(users).values({ displayName: '수료생', privateEmail: `cert+${id()}@example.test`, status }).returning()
    return row!.id
  }

  async function institution(tx: DbExecutor) {
    const name = `캠프${id().slice(0, 8)}`
    const [row] = await tx.insert(schools).values({ name, nameKey: name, kind: 'bootcamp' }).returning()
    return row!.id
  }

  /** 수료증 요청 하나(소속 + 확인 행, 필요하면 파일). */
  async function certificate(
    tx: DbExecutor,
    schoolId: string,
    opts: {
      status?: 'pending' | 'active' | 'revoked' | 'expired'
      uploaded?: boolean
      scanStatus?: 'pending' | 'clean' | 'quarantined'
      decidedAt?: Date
      createdAt?: Date
      userId?: string
      fileMtime?: Date
    } = {},
  ) {
    const userId = opts.userId ?? (await user(tx))
    const createdAt = opts.createdAt ?? ago(HOUR)
    const status = opts.status ?? 'pending'
    const [aff] = await tx
      .insert(institutionAffiliations)
      .values({
        userId,
        institutionKind: 'bootcamp',
        schoolId,
        method: 'certificate_check',
        standing: 'alumni',
        status,
        verifiedAt: status === 'active' ? (opts.decidedAt ?? NOW) : null,
        revokedAt: status === 'revoked' ? ago(HOUR) : null,
        revokedReason: status === 'revoked' ? 'user_removed' : null,
        createdAt,
      })
      .returning()
    const key = newQuarantineKey()
    const uploaded = opts.uploaded ?? true
    if (uploaded) {
      await storage.put(key, Readable.from([Buffer.from('certificate')]), { maxBytes: 100 })
      if (opts.fileMtime) {
        const uuid = key.split('/')[1]!
        await utimes(path.join(root, 'quarantine', uuid.slice(0, 2), uuid), opts.fileMtime, opts.fileMtime)
      }
    }
    const [check] = await tx
      .insert(certificateChecks)
      .values({
        affiliationId: aff!.id,
        userId,
        objectKey: key,
        declaredType: 'image/png',
        fileExtension: 'png',
        byteSize: 11,
        sha256: uploaded ? 'a'.repeat(64) : null,
        uploadedAt: uploaded ? createdAt : null,
        scanStatus: opts.scanStatus ?? (uploaded ? 'clean' : 'pending'),
        result: opts.decidedAt ? 'approved' : null,
        decidedAt: opts.decidedAt ?? null,
        createdAt,
      })
      .returning()
    return { userId, affiliationId: aff!.id, checkId: check!.id, key }
  }

  const checkRow = async (tx: DbExecutor, checkId: string) => (await tx.select().from(certificateChecks).where(eq(certificateChecks.id, checkId)))[0]!
  const affRow = async (tx: DbExecutor, affId: string) => (await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, affId)))[0]!

  it('deletes decided, cancelled, quarantined, never-uploaded and stale certificate files, recording ledger rows without personal data', async () => {
    await rollback(async (tx) => {
      const schoolId = await institution(tx)
      const decided = await certificate(tx, schoolId, { status: 'active', decidedAt: new Date(NOW.getTime() - 5 * 60 * 1000 + 17_000) })
      const waiting = await certificate(tx, schoolId)
      const cancelled = await certificate(tx, schoolId, { status: 'revoked' })
      const quarantined = await certificate(tx, schoolId, { scanStatus: 'quarantined' })
      const notUploaded = await certificate(tx, schoolId, { uploaded: false, createdAt: ago(2 * DAY) })
      const stale = await certificate(tx, schoolId, { createdAt: ago(31 * DAY) })

      const outcome = await purgeCertificateFiles(tx, deps(), NOW)
      expect(outcome.affected).toBeGreaterThanOrEqual(5)

      for (const c of [decided, cancelled, quarantined, notUploaded, stale]) {
        expect(await checkRow(tx, c.checkId)).toMatchObject({ objectKey: null, filePurgedAt: NOW })
        expect(await storage.head(c.key as ObjectKey)).toBeNull()
      }
      // 기다리는 요청의 파일은 그대로입니다.
      expect(await checkRow(tx, waiting.checkId)).toMatchObject({ objectKey: waiting.key, filePurgedAt: null })
      expect(await storage.head(waiting.key as ObjectKey)).not.toBeNull()
      // 오래 결정되지 않았거나 올리지 않았거나 격리된 요청은 끝냅니다. 결정된 소속은 그대로입니다.
      expect((await affRow(tx, stale.affiliationId)).status).toBe('expired')
      expect((await affRow(tx, notUploaded.affiliationId)).status).toBe('expired')
      expect((await affRow(tx, quarantined.affiliationId)).status).toBe('expired')
      expect((await affRow(tx, decided.affiliationId)).status).toBe('active')

      // 장부: 올린 파일마다 한 행(올리지 않은 요청은 없음), 확인 id의 HMAC, retention.
      const subjects = [decided, cancelled, quarantined, notUploaded, stale].map((c) => hashSubject(DELETION_PEPPER, c.checkId))
      const ledger = await tx.select().from(deletionLedger).where(inArray(deletionLedger.subjectHash, subjects))
      expect(ledger).toHaveLength(4)
      expect(ledger.every((r) => r.entityKind === CERTIFICATE_LEDGER_KIND && r.source === 'retention' && r.count === 1)).toBe(true)
      expect(ledger.find((r) => r.subjectHash === subjects[0])!.requestedAt).toEqual(new Date(NOW.getTime() - 5 * 60 * 1000))
      const text = JSON.stringify(ledger)
      for (const c of [decided, cancelled, quarantined, stale]) {
        expect(text).not.toContain(c.userId)
        expect(text).not.toContain(c.checkId)
      }
      expect(text).not.toContain(schoolId)

      // 다시 돌려도 바뀌는 것 없음.
      await purgeCertificateFiles(tx, deps(), NOW)
      expect(await storage.head(waiting.key as ObjectKey)).not.toBeNull()
      expect(await tx.select().from(deletionLedger).where(inArray(deletionLedger.subjectHash, subjects))).toHaveLength(4)
    })
  })

  it('a decided file is deleted within the window (next run), never before the decision', async () => {
    await rollback(async (tx) => {
      const schoolId = await institution(tx)
      const c = await certificate(tx, schoolId)
      await purgeCertificateFiles(tx, deps(), NOW)
      expect(await storage.head(c.key as ObjectKey)).not.toBeNull()
      const decidedAt = new Date(NOW.getTime() + 60_000)
      await tx.update(certificateChecks).set({ result: 'rejected', decidedAt }).where(eq(certificateChecks.id, c.checkId))
      // 10분 주기의 다음 실행(결정 뒤 7일 한도보다 훨씬 이름).
      const next = new Date(decidedAt.getTime() + 10 * 60_000)
      await purgeCertificateFiles(tx, deps(), next)
      const row = await checkRow(tx, c.checkId)
      expect(row.filePurgedAt!.getTime() - decidedAt.getTime()).toBeLessThan(7 * DAY)
      expect(await storage.head(c.key as ObjectKey)).toBeNull()
    })
  })

  it('re-applies certificate file deletions after a restore without touching the account', async () => {
    await rollback(async (tx) => {
      const schoolId = await institution(tx)
      const c = await certificate(tx, schoolId, { status: 'active', decidedAt: ago(HOUR) })
      await purgeCertificateFiles(tx, deps(), NOW)
      const subject = hashSubject(DELETION_PEPPER, c.checkId)
      const entries = (await exportLedger(tx)).filter((e) => e.subjectHash === subject)
      expect(entries).toEqual([expect.objectContaining({ entityKind: 'certificate_file', source: 'retention', count: 1 })])

      // 오래된 백업 복구: 행이 파일을 가리키고 파일도 다시 있음, 장부 항목은 없음.
      const restoredKey = newQuarantineKey()
      await storage.put(restoredKey, Readable.from([Buffer.from('restored')]), { maxBytes: 100 })
      await tx.delete(deletionLedger).where(eq(deletionLedger.subjectHash, subject))
      await tx.update(certificateChecks).set({ objectKey: restoredKey, filePurgedAt: null }).where(eq(certificateChecks.id, c.checkId))

      const dry = await reapplyDeletions(tx, purgeDeps(), { entries, now: NOW, dryRun: true })
      expect(dry).toMatchObject({ subjects: 0, matched: 0, retentionRepurged: 1 })
      expect(await storage.head(restoredKey)).not.toBeNull()
      const result = await reapplyDeletions(tx, purgeDeps(), { entries, now: NOW })
      expect(result).toMatchObject({ subjects: 0, matched: 0, repurged: 0, imported: 1, retentionRepurged: 1 })
      expect(await storage.head(restoredKey)).toBeNull()
      expect(await checkRow(tx, c.checkId)).toMatchObject({ objectKey: null, filePurgedAt: NOW })
      // 계정은 그대로입니다(retention 항목은 계정 정리 대상이 아님).
      const [u] = await tx.select().from(users).where(eq(users.id, c.userId))
      expect(u!.status).toBe('active')
      expect((await affRow(tx, c.affiliationId)).status).toBe('active')
      expect((await reapplyDeletions(tx, purgeDeps(), { entries, now: NOW })).retentionRepurged).toBe(0)
    })
  })

  it('orphan quarantine cleanup keeps certificate files; affiliation-code cleanup leaves non-email requests alone and expires 30-day cohort requests', async () => {
    await rollback(async (tx) => {
      const schoolId = await institution(tx)
      const old = ago(3 * DAY)
      const c = await certificate(tx, schoolId, { fileMtime: old })
      const orphan = newQuarantineKey()
      await storage.put(orphan, Readable.from([Buffer.from('x')]), { maxBytes: 10 })
      const uuid = orphan.split('/')[1]!
      await utimes(path.join(root, 'quarantine', uuid.slice(0, 2), uuid), old, old)
      await cleanupOrphanQuarantine(tx, { storage, batchSize: 100 }, NOW)
      expect(await storage.head(orphan)).toBeNull()
      expect(await storage.head(c.key as ObjectKey)).not.toBeNull()

      const [cohort] = await tx.insert(institutionCohorts).values({ schoolId, label: '1기', labelKey: '1기' }).returning()
      const cohortRequest = async (createdAt: Date) =>
        (
          await tx
            .insert(institutionAffiliations)
            .values({ userId: await user(tx), institutionKind: 'bootcamp', schoolId, method: 'cohort_approval', cohortId: cohort!.id, standing: 'student', status: 'pending', createdAt })
            .returning()
        )[0]!
      const oldRequest = await cohortRequest(ago(31 * DAY))
      const freshRequest = await cohortRequest(ago(2 * DAY))
      const oldCertificate = await certificate(tx, schoolId, { createdAt: ago(10 * DAY) })
      await cleanupAffiliationCodes(tx, { storage, batchSize: 100 }, NOW)
      expect((await affRow(tx, oldRequest.id)).status).toBe('expired')
      expect((await affRow(tx, freshRequest.id)).status).toBe('pending')
      expect((await affRow(tx, oldCertificate.affiliationId)).status).toBe('pending')
      expect((await affRow(tx, c.affiliationId)).status).toBe('pending')
    })
  })

  it('account purge deletes the person\'s certificate checks and files and every cohort approval by or for them', async () => {
    await rollback(async (tx) => {
      const schoolId = await institution(tx)
      const leaver = await user(tx, 'deleted')
      const c = await certificate(tx, schoolId, { userId: leaver })
      const [cohort] = await tx.insert(institutionCohorts).values({ schoolId, label: '2기', labelKey: '2기', createdBy: leaver }).returning()
      const verified = async (userId: string) =>
        (
          await tx
            .insert(institutionAffiliations)
            .values({ userId, institutionKind: 'bootcamp', schoolId, method: 'invite_code', cohortId: cohort!.id, standing: 'alumni', status: 'active', verifiedAt: ago(DAY) })
            .returning()
        )[0]!
      const other = await user(tx)
      const otherAff = await verified(other)
      // 탈퇴하는 사람이 남을 승인한 기록(그 사람의 다른 기관 인증으로)과, 그 사람의 요청이 받은 승인.
      const leaverSchool = await institution(tx)
      const [leaverCohort] = await tx.insert(institutionCohorts).values({ schoolId: leaverSchool, label: '2기', labelKey: '2기' }).returning()
      const [leaverAff] = await tx
        .insert(institutionAffiliations)
        .values({ userId: leaver, institutionKind: 'bootcamp', schoolId: leaverSchool, method: 'invite_code', cohortId: leaverCohort!.id, standing: 'alumni', status: 'active', verifiedAt: ago(DAY) })
        .returning()
      const third = await user(tx)
      const [thirdRequest] = await tx
        .insert(institutionAffiliations)
        .values({ userId: third, institutionKind: 'bootcamp', schoolId: leaverSchool, method: 'cohort_approval', cohortId: leaverCohort!.id, standing: 'student', status: 'pending' })
        .returning()
      await tx.insert(cohortApprovals).values({ affiliationId: thirdRequest!.id, approverUserId: leaver, approverAffiliationId: leaverAff!.id })
      const [leaverRequest] = await tx
        .insert(institutionAffiliations)
        .values({ userId: leaver, institutionKind: 'bootcamp', schoolId, method: 'cohort_approval', cohortId: cohort!.id, standing: 'student', status: 'expired' })
        .returning()
      await tx.insert(cohortApprovals).values({ affiliationId: leaverRequest!.id, approverUserId: other, approverAffiliationId: otherAff.id })

      const counts = await purgeAccount(tx, purgeDeps(), leaver, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ certificate_checks: 1, certificate_files: 1, cohort_approvals: 2 })
      expect(counts!.artifact_objects).toBeUndefined()
      expect(await tx.select().from(certificateChecks).where(eq(certificateChecks.userId, leaver))).toEqual([])
      expect(await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.userId, leaver))).toEqual([])
      expect(await tx.select().from(cohortApprovals).where(eq(cohortApprovals.approverUserId, leaver))).toEqual([])
      expect(await storage.head(c.key as ObjectKey)).toBeNull()
      // 다른 사람의 소속·기수 행은 남습니다.
      expect((await affRow(tx, otherAff.id)).status).toBe('active')
      expect((await affRow(tx, thirdRequest!.id)).status).toBe('pending')
      expect(await tx.select().from(institutionCohorts).where(and(eq(institutionCohorts.id, cohort!.id)))).toHaveLength(1)
    })
  })
})
