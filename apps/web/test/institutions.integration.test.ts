/**
 * I-01 기관 일반화·인증 수단 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * - P2 플래그(institutions)가 꺼져 있으면 새 서비스는 모두 404.
 * - 초대 코드: 원문 없이 HMAC만, 만료·사용 한도·철회·없는 코드 거부, 사용자별 시도 한도.
 * - 기수 승인: 승인 2개 필요, 기수 승인으로만 인증된 멤버의 승인은 받지 않음(404), 자기 승인·중복 승인 거부.
 * - 수료증: 요청 → 업로드 → 검사(파일 격리 키에 그대로) → 60초 서명 URL(그 운영자에게만) → 결정 → 결정 뒤 파일 못 받음.
 *   파일 삭제·삭제 장부는 worker 테스트(apps/worker/test/ops-certificates.test.ts)에서 봅니다.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { normalizeInviteCode } from '@peerchive/domain'
import {
  and,
  auditEvents,
  certificateChecks,
  cohortApprovals,
  eq,
  institutionAffiliations,
  institutionInviteCodes,
  operators,
  schools,
  type DbExecutor,
} from '@peerchive/db'
import { createFilesystemStorage, createSignatureOnlyScanner, readAll, scanCertificateCheck, type ObjectStorage } from '@peerchive/files'
import { listMyAffiliations, removeAffiliation } from '../server/modules/affiliation/affiliations'
import { affiliationPepper } from '../server/modules/affiliation/config'
import { createCourse, createSchool, searchSchools } from '../server/modules/catalog/catalog'
import { mergeSchool } from '../server/modules/catalog/merge'
import { featureFlags, setFeatureEnvForTesting } from '../server/modules/features'
import {
  certificateFileSignature,
  certificateFileUrl,
  decideCertificateCheck,
  listCertificateChecks,
  openCertificateFile,
  requestCertificateCheck,
  uploadCertificate,
} from '../server/modules/institutions/certificates'
import { approveCohortMember, getCohortApprovalRequest, requestCohortApproval } from '../server/modules/institutions/cohort-approvals'
import {
  createInstitution,
  hashInviteCode,
  issueInviteCode,
  listInviteCodes,
  redeemInviteCode,
  revokeInviteCode,
  searchInstitutions,
} from '../server/modules/institutions/institutions'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-03T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const ON = { PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'on' }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const scanner = createSignatureOnlyScanner()

async function operator(db: DbExecutor) {
  const user = await createUser(db)
  await db.insert(operators).values({ userId: user.id })
  return { userId: user.id }
}

async function bootcamp(db: DbExecutor, op: { userId: string }, kind: 'bootcamp' | 'training_program' = 'bootcamp') {
  return createInstitution(db, op, { name: `피어캠프${token()}`, kind }, T0)
}

/** 초대 코드로 그 기수에 active 인증된 사용자. */
async function inviteVerified(db: DbExecutor, op: { userId: string }, institutionId: string, cohortLabel: string) {
  const user = await createUser(db)
  const issued = await issueInviteCode(db, op, institutionId, { maxUses: 5, cohortLabel }, T0)
  const dto = await redeemInviteCode(db, { userId: user.id }, { code: issued.code, standing: 'alumni' }, { ip: crypto.randomUUID(), now: at(1) })
  return { userId: user.id, affiliationId: dto.id }
}

describe.skipIf(!databaseUrl)('institutions and verification methods (PostgreSQL, I-01)', () => {
  let root: string
  let storage: ObjectStorage
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-institutions-'))
    storage = createFilesystemStorage(root)
  })
  afterAll(async () => {
    await closeTestDb()
    await rm(root, { recursive: true, force: true })
  })
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('flag off (default): every new P2 service is 404 and the feature endpoint says off', async () => {
    setFeatureEnvForTesting({})
    expect(featureFlags()).toEqual({ alumni: false, topics: false, institutions: false })
    setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2: 'on', PEERCHIVE_FEATURE_P2_TOPICS: 'off' })
    expect(featureFlags()).toEqual({ alumni: true, topics: false, institutions: true })
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const inst = await bootcamp(tx, op)
      const issued = await issueInviteCode(tx, op, inst.id, { maxUses: 1 }, T0)
      const user = await createUser(tx)
      setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'off' })
      const id = crypto.randomUUID()
      const u = { userId: user.id }
      await expectServiceError(createInstitution(tx, op, { name: '새캠프', kind: 'bootcamp' }), 'NOT_FOUND')
      await expectServiceError(searchInstitutions(tx, u, { q: '피어' }), 'NOT_FOUND')
      await expectServiceError(issueInviteCode(tx, op, inst.id, { maxUses: 1 }), 'NOT_FOUND')
      await expectServiceError(listInviteCodes(tx, op, inst.id), 'NOT_FOUND')
      await expectServiceError(revokeInviteCode(tx, op, issued.id), 'NOT_FOUND')
      await expectServiceError(redeemInviteCode(tx, u, { code: issued.code, standing: 'student' }, { ip: 'x' }), 'NOT_FOUND')
      await expectServiceError(requestCohortApproval(tx, u, { institutionId: inst.id, cohortLabel: '1기', standing: 'student' }), 'NOT_FOUND')
      await expectServiceError(getCohortApprovalRequest(tx, u, id), 'NOT_FOUND')
      await expectServiceError(approveCohortMember(tx, u, id), 'NOT_FOUND')
      await expectServiceError(
        requestCertificateCheck(tx, u, { institutionId: inst.id, standing: 'alumni', declaredType: 'image/png', fileName: 'a.png', byteSize: PNG.length }),
        'NOT_FOUND',
      )
      await expectServiceError(uploadCertificate(tx, storage, u, id, Readable.from([PNG])), 'NOT_FOUND')
      await expectServiceError(listCertificateChecks(tx, op, {}), 'NOT_FOUND')
      await expectServiceError(certificateFileUrl(tx, op, id), 'NOT_FOUND')
      await expectServiceError(openCertificateFile(tx, storage, op, id, {}), 'NOT_FOUND')
      await expectServiceError(decideCertificateCheck(tx, op, id, { result: 'approved' }), 'NOT_FOUND')
      // 기존 목록은 그대로 동작합니다.
      expect((await listMyAffiliations(tx, u)).items).toEqual([])
    })
  })

  it('institutions: operator-only, non-university kinds, hidden from school search; no courses or merges', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const student = await createUser(tx)
      await expectServiceError(createInstitution(tx, { userId: student.id }, { name: '캠프', kind: 'bootcamp' }), 'FORBIDDEN', 'operator_only')
      const e = await expectServiceError(createInstitution(tx, op, { name: '대학교', kind: 'university' }), 'VALIDATION')
      expect(e.fields).toEqual({ kind: 'invalid' })
      const t = token()
      const inst = await createInstitution(tx, op, { name: `  코드  스쿨${t} `, kind: 'training_program' }, T0)
      expect(inst).toMatchObject({ name: `코드 스쿨${t}`, kind: 'training_program' })
      await expectServiceError(createInstitution(tx, op, { name: `코드스쿨${t}`, kind: 'bootcamp' }), 'CONFLICT', 'already_exists')
      const audit = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, inst.id))
      expect(audit.map((a) => [a.action, a.metadata])).toEqual([['institution.create', { kind: 'training_program' }]])

      const university = await createSchool(tx, op, { name: `코드스쿨대${t}학교`, confirmNew: true }, T0)
      expect((await searchSchools(tx, `코드스쿨${t}`)).map((s) => s.id)).not.toContain(inst.id)
      expect((await searchInstitutions(tx, { userId: student.id }, { q: `스쿨${t}` })).map((s) => s.id)).toEqual([inst.id])
      expect(await searchInstitutions(tx, { userId: student.id }, { q: `코드스쿨${t}`, kind: 'bootcamp' })).toEqual([])
      const [row] = await tx.select().from(schools).where(eq(schools.id, university.id))
      expect(row!.kind).toBe('university')

      const course = await expectServiceError(createCourse(tx, op, inst.id, { title: '자료구조', confirmNew: true }), 'VALIDATION')
      expect(course.fields).toEqual({ schoolId: 'not_university' })
      await expectServiceError(mergeSchool(tx, op, inst.id, { into: university.id }), 'CONFLICT', 'not_university')
      await expectServiceError(mergeSchool(tx, op, university.id, { into: inst.id }), 'CONFLICT', 'not_university')
    })
  })

  it('invite codes: HMAC only, plaintext shown once; expiry, usage limit and revocation reject; redemption creates an invite_code affiliation', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const inst = await bootcamp(tx, op)
      const university = await createSchool(tx, op, { name: `초대대${token()}학교`, confirmNew: true }, T0)
      await expectServiceError(issueInviteCode(tx, { userId: (await createUser(tx)).id }, inst.id, { maxUses: 1 }), 'FORBIDDEN', 'operator_only')
      expect((await expectServiceError(issueInviteCode(tx, op, university.id, { maxUses: 1 }), 'VALIDATION')).fields).toEqual({ institutionId: 'not_supported' })
      expect((await expectServiceError(issueInviteCode(tx, op, inst.id, { maxUses: 0 }), 'VALIDATION')).fields).toEqual({ maxUses: 'invalid' })
      expect((await expectServiceError(issueInviteCode(tx, op, inst.id, { maxUses: 2, expiresInDays: 91 }), 'VALIDATION')).fields).toEqual({ expiresInDays: 'invalid' })

      const issued = await issueInviteCode(tx, op, inst.id, { maxUses: 2, expiresInDays: 7, cohortLabel: ' 12 기 ' }, T0)
      expect(issued.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
      expect(issued).toMatchObject({ cohortLabel: '12 기', maxUses: 2, usedCount: 0, expiresAt: new Date(T0.getTime() + days(7)).toISOString() })
      // 저장된 행에는 원문이 없고 HMAC만 있습니다.
      const [stored] = await tx.select().from(institutionInviteCodes).where(eq(institutionInviteCodes.id, issued.id))
      expect(Object.keys(stored!).sort()).toEqual(['codeHash', 'cohortId', 'createdAt', 'expiresAt', 'id', 'issuedBy', 'maxUses', 'revokedAt', 'schoolId', 'usedCount'])
      expect(stored!.codeHash).toBe(hashInviteCode(affiliationPepper(), normalizeInviteCode(issued.code)!))
      const normalized = normalizeInviteCode(issued.code)!
      expect(JSON.stringify(stored)).not.toContain(normalized)
      expect(JSON.stringify(await listInviteCodes(tx, op, inst.id))).not.toContain(normalized)
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, issued.id))
      expect(JSON.stringify(audits)).not.toContain(normalized)

      const a = await createUser(tx)
      const b = await createUser(tx)
      const c = await createUser(tx)
      const ctx = (n: number) => ({ ip: crypto.randomUUID(), now: at(n) })
      // 소문자·공백·하이픈 없이 넣어도 같은 코드.
      const mine = await redeemInviteCode(tx, { userId: a.id }, { code: ` ${normalized.toLowerCase()} `, standing: 'student' }, ctx(1))
      expect(mine).toMatchObject({ status: 'active', method: 'invite_code', institutionKind: 'bootcamp', cohortLabel: '12 기', emailDomain: null, school: { id: inst.id } })
      await expectServiceError(redeemInviteCode(tx, { userId: a.id }, { code: issued.code, standing: 'student' }, ctx(2)), 'CONFLICT', 'already_verified')
      await redeemInviteCode(tx, { userId: b.id }, { code: issued.code, standing: 'alumni' }, ctx(2))
      // 사용 한도(2)를 다 썼습니다.
      await expectServiceError(redeemInviteCode(tx, { userId: c.id }, { code: issued.code, standing: 'student' }, ctx(3)), 'GONE', 'invite_code_exhausted')
      const [after] = await tx.select().from(institutionInviteCodes).where(eq(institutionInviteCodes.id, issued.id))
      expect(after!.usedCount).toBe(2)
      const verifyAudit = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, mine.id), eq(auditEvents.action, 'affiliation.verify')))
      expect(verifyAudit[0]!.metadata).toEqual({ schoolId: inst.id, method: 'invite_code', standing: 'student', inviteCodeId: issued.id })

      // 만료
      const short = await issueInviteCode(tx, op, inst.id, { maxUses: 5, expiresInDays: 1 }, T0)
      await expectServiceError(
        redeemInviteCode(tx, { userId: c.id }, { code: short.code, standing: 'student' }, { ip: 'x', now: new Date(T0.getTime() + days(1)) }),
        'GONE',
        'invite_code_expired',
      )
      // 철회(이미 만든 소속은 그대로)
      const revocable = await issueInviteCode(tx, op, inst.id, { maxUses: 5 }, T0)
      const d = await createUser(tx)
      const kept = await redeemInviteCode(tx, { userId: d.id }, { code: revocable.code, standing: 'student' }, ctx(4))
      expect((await revokeInviteCode(tx, op, revocable.id, at(5))).revokedAt).toBe(at(5).toISOString())
      expect((await revokeInviteCode(tx, op, revocable.id, at(6))).revokedAt).toBe(at(5).toISOString())
      await expectServiceError(redeemInviteCode(tx, { userId: c.id }, { code: revocable.code, standing: 'student' }, ctx(7)), 'GONE', 'invite_code_revoked')
      const [keptRow] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, kept.id))
      expect(keptRow!.status).toBe('active')
      // 없는 코드·형식
      expect((await expectServiceError(redeemInviteCode(tx, { userId: c.id }, { code: 'AAAA-BBBB-CCCC', standing: 'student' }, ctx(8)), 'VALIDATION', 'invite_code_invalid')).fields).toEqual({
        code: 'invite_code_invalid',
      })
      expect((await expectServiceError(redeemInviteCode(tx, { userId: c.id }, { code: 'short', standing: 'student' }, ctx(8)), 'VALIDATION')).fields).toEqual({
        code: 'invalid_format',
      })
    })
  })

  it('invite codes: redemption attempts are rate limited per user (right or wrong) and per IP', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const inst = await bootcamp(tx, op)
      const user = await createUser(tx)
      for (let i = 0; i < 10; i++) {
        await expectServiceError(redeemInviteCode(tx, { userId: user.id }, { code: 'AAAA-BBBB-CCCC', standing: 'student' }, { ip: crypto.randomUUID(), now: at(1) }), 'VALIDATION')
      }
      const issued = await issueInviteCode(tx, op, inst.id, { maxUses: 1 }, T0)
      await expectServiceError(redeemInviteCode(tx, { userId: user.id }, { code: issued.code, standing: 'student' }, { ip: crypto.randomUUID(), now: at(2) }), 'RATE_LIMITED')
      // 한 시간 뒤에는 다시 됩니다.
      expect((await redeemInviteCode(tx, { userId: user.id }, { code: issued.code, standing: 'student' }, { ip: crypto.randomUUID(), now: at(61) })).status).toBe('active')
      // IP 한도(30)
      const ip = crypto.randomUUID()
      for (let i = 0; i < 30; i++) {
        const other = await createUser(tx)
        await expectServiceError(redeemInviteCode(tx, { userId: other.id }, { code: 'AAAA-BBBB-CCCC', standing: 'student' }, { ip, now: at(70) }), 'VALIDATION')
      }
      const last = await createUser(tx)
      await expectServiceError(redeemInviteCode(tx, { userId: last.id }, { code: 'AAAA-BBBB-CCCC', standing: 'student' }, { ip, now: at(70) }), 'RATE_LIMITED')
    })
  })

  it('cohort approval: two approvals from the same cohort verified by a non-approval method; no self, duplicate, cross-cohort or approval-only approvals', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const inst = await bootcamp(tx, op)
      const requester = await createUser(tx)
      const req = await requestCohortApproval(tx, { userId: requester.id }, { institutionId: inst.id, cohortLabel: '7기', standing: 'alumni' }, at(1))
      expect(req).toMatchObject({ status: 'pending', method: 'cohort_approval', cohortLabel: '7기', cohortApprovals: { count: 0, required: 2 } })
      expect((await expectServiceError(requestCohortApproval(tx, { userId: requester.id }, { institutionId: inst.id, cohortLabel: '', standing: 'alumni' }), 'VALIDATION')).fields).toEqual({
        cohortLabel: 'required',
      })

      const b = await inviteVerified(tx, op, inst.id, '7 기') // 같은 기수(공백 무시)
      const c = await inviteVerified(tx, op, inst.id, '7기')
      const otherCohort = await inviteVerified(tx, op, inst.id, '8기')
      const outsider = await createUser(tx)

      // 자격 없는 사람에게는 요청이 보이지 않습니다.
      await expectServiceError(getCohortApprovalRequest(tx, { userId: outsider.id }, req.id), 'NOT_FOUND')
      await expectServiceError(approveCohortMember(tx, { userId: outsider.id }, req.id), 'NOT_FOUND')
      await expectServiceError(approveCohortMember(tx, { userId: otherCohort.userId }, req.id), 'NOT_FOUND')
      // 본인 승인
      expect((await expectServiceError(approveCohortMember(tx, { userId: requester.id }, req.id), 'VALIDATION')).fields).toEqual({ affiliationId: 'self_approval' })

      const view = await getCohortApprovalRequest(tx, { userId: b.userId }, req.id)
      expect(view).toMatchObject({ cohortLabel: '7기', approvals: 0, required: 2, approvedByMe: false, status: 'pending', institution: { id: inst.id, kind: 'bootcamp' } })
      expect(await approveCohortMember(tx, { userId: b.userId }, req.id, at(2))).toMatchObject({ approvals: 1, approvedByMe: true, status: 'pending' })
      await expectServiceError(approveCohortMember(tx, { userId: b.userId }, req.id, at(3)), 'CONFLICT', 'already_approved')
      expect((await listMyAffiliations(tx, { userId: requester.id })).items[0]).toMatchObject({ status: 'pending', cohortApprovals: { count: 1, required: 2 } })

      expect(await approveCohortMember(tx, { userId: c.userId }, req.id, at(4))).toMatchObject({ approvals: 2, status: 'active' })
      const [verified] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, req.id))
      expect(verified).toMatchObject({ status: 'active', method: 'cohort_approval', verifiedAt: at(4) })
      const approvals = await tx.select().from(cohortApprovals).where(eq(cohortApprovals.affiliationId, req.id))
      expect(approvals.map((a) => a.approverAffiliationId).sort()).toEqual([b.affiliationId, c.affiliationId].sort())
      const approveAudit = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, req.id), eq(auditEvents.action, 'cohort_approval.approve')))
      expect(approveAudit.map((a) => a.metadata)).toContainEqual({ schoolId: inst.id, approvals: 2, verified: true, approverMethod: 'invite_code' })

      // 끝난 요청에는 더 승인할 수 없습니다.
      const d = await inviteVerified(tx, op, inst.id, '7기')
      await expectServiceError(approveCohortMember(tx, { userId: d.userId }, req.id), 'CONFLICT', 'not_pending')

      // 기수 승인으로만 인증된 멤버(requester)의 승인은 받지 않습니다(같은 기수여도 404).
      const next = await createUser(tx)
      const req2 = await requestCohortApproval(tx, { userId: next.id }, { institutionId: inst.id, cohortLabel: '7기', standing: 'student' }, at(5))
      await expectServiceError(getCohortApprovalRequest(tx, { userId: requester.id }, req2.id), 'NOT_FOUND')
      await expectServiceError(approveCohortMember(tx, { userId: requester.id }, req2.id), 'NOT_FOUND')
      expect((await getCohortApprovalRequest(tx, { userId: d.userId }, req2.id)).approvals).toBe(0)
      // 취소한 요청
      await removeAffiliation(tx, { userId: next.id }, req2.id, at(6))
      await expectServiceError(approveCohortMember(tx, { userId: d.userId }, req2.id), 'CONFLICT', 'not_pending')
      // 대학에는 기수 승인이 없습니다.
      const university = await createSchool(tx, op, { name: `기수대${token()}학교`, confirmNew: true }, T0)
      expect(
        (await expectServiceError(requestCohortApproval(tx, { userId: outsider.id }, { institutionId: university.id, cohortLabel: '1기', standing: 'student' }), 'VALIDATION')).fields,
      ).toEqual({ institutionId: 'not_supported' })
    })
  })

  it('certificate: upload → scan (stays in quarantine, metadata stripped) → short signed URL for that operator only → decision; no file access after the decision', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const op2 = await operator(tx)
      const inst = await bootcamp(tx, op)
      const user = await createUser(tx)
      const u = { userId: user.id }
      const bad = await expectServiceError(
        requestCertificateCheck(tx, u, { institutionId: inst.id, standing: 'alumni', declaredType: 'image/svg+xml', fileName: 'a.svg', byteSize: 10 }),
        'VALIDATION',
      )
      expect(bad.fields).toEqual({ declaredType: 'unsupported_type' })
      expect(
        (await expectServiceError(requestCertificateCheck(tx, u, { institutionId: inst.id, standing: 'alumni', declaredType: 'image/png', fileName: 'a.pdf', byteSize: 10 }), 'VALIDATION')).fields,
      ).toEqual({ fileName: 'extension_mismatch' })
      expect(
        (
          await expectServiceError(
            requestCertificateCheck(tx, u, { institutionId: inst.id, standing: 'alumni', declaredType: 'image/png', fileName: 'a.png', byteSize: 11 * 1024 * 1024 }),
            'VALIDATION',
          )
        ).fields,
      ).toEqual({ byteSize: 'too_large' })

      const created = await requestCertificateCheck(
        tx,
        u,
        { institutionId: inst.id, standing: 'alumni', cohortLabel: '3기', declaredType: 'image/png', fileName: '홍길동_수료증.png', byteSize: PNG.length },
        at(1),
      )
      expect(created.uploadUrl).toBe(`/api/v1/me/affiliations/${created.affiliation.id}/certificate`)
      expect(created.affiliation).toMatchObject({ status: 'pending', method: 'certificate_check', cohortLabel: '3기', certificate: { uploaded: false, scanStatus: 'pending', result: null } })
      const [check0] = await tx.select().from(certificateChecks).where(eq(certificateChecks.affiliationId, created.affiliation.id))
      // 원래 파일 이름은 어디에도 저장하지 않습니다(확장자만).
      expect(JSON.stringify(check0)).not.toContain('홍길동')
      expect(check0).toMatchObject({ fileExtension: 'png', declaredType: 'image/png' })

      // 남의 요청에는 올릴 수 없고, 크기가 다르면 거부합니다.
      await expectServiceError(uploadCertificate(tx, storage, { userId: op.userId }, created.affiliation.id, Readable.from([PNG])), 'NOT_FOUND')
      await expectServiceError(uploadCertificate(tx, storage, u, created.affiliation.id, Readable.from([PNG]), { contentLength: PNG.length + 1 }), 'PAYLOAD_TOO_LARGE')
      const uploaded = await uploadCertificate(tx, storage, u, created.affiliation.id, Readable.from([PNG]), { contentLength: PNG.length }, at(2))
      expect(uploaded.certificate).toMatchObject({ uploaded: true, scanStatus: 'pending' })
      await expectServiceError(uploadCertificate(tx, storage, u, created.affiliation.id, Readable.from([PNG])), 'CONFLICT', 'already_uploaded')

      // 검사 전에는 목록에 보여도 열 수 없습니다.
      const pendingList = await listCertificateChecks(tx, op, {})
      const listed = pendingList.find((c) => c.affiliationId === created.affiliation.id)!
      expect(listed).toMatchObject({ viewable: false, scanStatus: 'pending', cohortLabel: '3기', institution: { id: inst.id }, user: { id: user.id } })
      await expectServiceError(certificateFileUrl(tx, op, listed.id), 'NOT_FOUND')
      await expectServiceError(decideCertificateCheck(tx, op, listed.id, { result: 'approved' }), 'CONFLICT', 'not_reviewable')

      expect(await scanCertificateCheck(tx, { storage, scanner }, listed.id)).toEqual({ status: 'clean' })
      const [scanned] = await tx.select().from(certificateChecks).where(eq(certificateChecks.id, listed.id))
      expect(scanned!.objectKey).toMatch(/^quarantine\//)
      expect(scanned).toMatchObject({ scanStatus: 'clean', mediaType: 'image/png' })

      await expectServiceError(certificateFileUrl(tx, u, listed.id), 'FORBIDDEN', 'operator_only')
      const signed = await certificateFileUrl(tx, op, listed.id, at(3))
      expect(new Date(signed.expiresAt).getTime() - at(3).getTime()).toBe(60_000)
      const params = new URL(signed.url, 'http://x').searchParams
      const query = { exp: params.get('exp')!, sig: params.get('sig')! }
      const file = await openCertificateFile(tx, storage, op, listed.id, query, at(3))
      expect(file.mediaType).toBe('image/png')
      expect((await readAll(file.stream)).subarray(0, 8)).toEqual(PNG.subarray(0, 8))
      // 다른 운영자·틀린 서명·만료 뒤·사용자는 404/403.
      await expectServiceError(openCertificateFile(tx, storage, op2, listed.id, query, at(3)), 'NOT_FOUND')
      await expectServiceError(openCertificateFile(tx, storage, op, listed.id, { exp: query.exp, sig: '0'.repeat(64) }, at(3)), 'NOT_FOUND')
      await expectServiceError(openCertificateFile(tx, storage, op, listed.id, query, at(5)), 'NOT_FOUND')
      await expectServiceError(openCertificateFile(tx, storage, u, listed.id, query, at(3)), 'FORBIDDEN', 'operator_only')
      expect(certificateFileSignature(affiliationPepper(), listed.id, op.userId, Number(query.exp))).toBe(query.sig)
      const viewAudit = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, listed.id), eq(auditEvents.action, 'certificate_check.view')))
      expect(viewAudit).toHaveLength(1)

      const decided = await decideCertificateCheck(tx, op, listed.id, { result: 'approved' }, at(10))
      expect(decided).toMatchObject({ result: 'approved', decidedAt: at(10).toISOString(), viewable: false })
      const [aff] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, created.affiliation.id))
      expect(aff).toMatchObject({ status: 'active', verifiedAt: at(10), method: 'certificate_check' })
      // 결정 뒤에는 운영자도 파일을 받을 수 없습니다(서명 URL이 아직 유효해도).
      const late = await certificateFileUrl(tx, op, listed.id, at(9)).catch((error) => error)
      expect(late).toMatchObject({ code: 'NOT_FOUND' })
      await expectServiceError(openCertificateFile(tx, storage, op, listed.id, query, at(3)), 'NOT_FOUND')
      await expectServiceError(decideCertificateCheck(tx, op, listed.id, { result: 'rejected' }), 'CONFLICT', 'already_decided')
      expect((await listCertificateChecks(tx, op, { status: 'decided' })).map((c) => c.id)).toContain(listed.id)
      const decideAudit = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, listed.id), eq(auditEvents.action, 'certificate_check.decide')))
      expect(decideAudit[0]!.metadata).toEqual({ result: 'approved', schoolId: inst.id, affiliationId: created.affiliation.id })

      // 거절은 revoked(certificate_rejected).
      const other = await createUser(tx)
      const second = await requestCertificateCheck(tx, { userId: other.id }, { institutionId: inst.id, standing: 'student', declaredType: 'image/png', fileName: 'b.png', byteSize: PNG.length }, at(11))
      await uploadCertificate(tx, storage, { userId: other.id }, second.affiliation.id, Readable.from([PNG]), {}, at(12))
      const [check2] = await tx.select().from(certificateChecks).where(eq(certificateChecks.affiliationId, second.affiliation.id))
      await scanCertificateCheck(tx, { storage, scanner }, check2!.id)
      await decideCertificateCheck(tx, op, check2!.id, { result: 'rejected' }, at(13))
      const mine = (await listMyAffiliations(tx, { userId: other.id })).items[0]!
      expect(mine).toMatchObject({ status: 'revoked', revokedReason: 'certificate_rejected', certificate: { result: 'rejected' } })
    })
  })

  it('a quarantined certificate is never viewable or decidable; a cancelled request cannot be decided', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const inst = await bootcamp(tx, op)
      const user = await createUser(tx)
      const html = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>')
      const req = await requestCertificateCheck(tx, { userId: user.id }, { institutionId: inst.id, standing: 'alumni', declaredType: 'image/png', fileName: 'x.png', byteSize: html.length }, at(1))
      await uploadCertificate(tx, storage, { userId: user.id }, req.affiliation.id, Readable.from([html]), {}, at(2))
      const [check] = await tx.select().from(certificateChecks).where(eq(certificateChecks.affiliationId, req.affiliation.id))
      expect((await scanCertificateCheck(tx, { storage, scanner }, check!.id)).status).toBe('quarantined')
      await expectServiceError(certificateFileUrl(tx, op, check!.id), 'NOT_FOUND')
      await expectServiceError(decideCertificateCheck(tx, op, check!.id, { result: 'approved' }), 'CONFLICT', 'not_reviewable')

      const again = await requestCertificateCheck(tx, { userId: user.id }, { institutionId: inst.id, standing: 'alumni', declaredType: 'image/png', fileName: 'y.png', byteSize: PNG.length }, at(3))
      // 새 요청은 이전 요청을 대체합니다(이전 행 expired, 파일은 worker가 지움).
      const [previous] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, req.affiliation.id))
      expect(previous!.status).toBe('expired')
      await uploadCertificate(tx, storage, { userId: user.id }, again.affiliation.id, Readable.from([PNG]), {}, at(4))
      const [check2] = await tx.select().from(certificateChecks).where(eq(certificateChecks.affiliationId, again.affiliation.id))
      await scanCertificateCheck(tx, { storage, scanner }, check2!.id)
      await removeAffiliation(tx, { userId: user.id }, again.affiliation.id, at(5))
      await expectServiceError(certificateFileUrl(tx, op, check2!.id), 'NOT_FOUND')
      await expectServiceError(decideCertificateCheck(tx, op, check2!.id, { result: 'approved' }), 'CONFLICT', 'not_reviewable')
    })
  })
})
