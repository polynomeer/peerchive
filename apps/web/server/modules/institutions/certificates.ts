/**
 * 수료증 확인 (I-01, SYSTEM_DESIGN §6.7.2 CertificateCheck·§8.4·§10, DELIVERY_PLAN §4.3 I-01·§5.3 Z, ADR 0037·0007·0016).
 * P2 플래그 `institutions`가 꺼져 있으면 404.
 *
 * 사용자
 * 1. `POST /me/affiliations/certificate {institutionId, standing, cohortLabel?, declaredType, fileName, byteSize}` → 201 + pending 소속
 *    (method certificate_check) + `uploadUrl`. 형식은 PNG·JPEG·WebP·PDF, 10MB까지. 원래 파일 이름은 확장자만 보고 저장하지 않습니다.
 * 2. `PUT /me/affiliations/:id/certificate`(본문 = 파일) → 200. 격리 키에 쓰고 검사 작업(`certificate-scan`)을 outbox에 남깁니다.
 *    worker가 형식 판별·내장 콘텐츠·악성코드 검사 뒤 메타데이터를 지운 내용으로 같은 격리 키를 바꿔 씁니다.
 * 운영자(운영자 확인 역할만 — 기관 운영진은 볼 수 없음, §8.4)
 * 3. `GET /operator/certificate-checks?status=pending|decided` — 목록(사용자 id·계정 이름·기관·기수·검사 상태·시각, 파일 이름 없음).
 * 4. `POST /operator/certificate-checks/:id/file-url` → 60초 서명 URL(그 운영자에게만 맞는 서명). 결정 전·검사 통과일 때만, 감사 `certificate_check.view`.
 *    `GET /operator/certificate-checks/:id/file?exp=&sig=` — 운영자 세션 + 맞는 서명 + 만료 전 + 결정 전 + 파일 있음이 모두 맞을 때만 내용, 그 밖은 404.
 * 5. `POST /operator/certificate-checks/:id/decision {result: approved|rejected}` → 승인이면 소속 active, 거절이면 revoked(`certificate_rejected`).
 *    결정 시각(decided_at)을 남깁니다(A-07 처리 시간). 결정 뒤에는 누구도 파일을 받을 수 없고, worker `certificate-files`가 10분 안에 파일을 지우고
 *    삭제 장부(source retention)에 남깁니다.
 */
import { createHmac } from 'node:crypto'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import {
  AFFILIATION_STANDINGS,
  CERTIFICATE_FILE_URL_TTL_MS,
  CERTIFICATE_RESULTS,
  INSTITUTION_REQUEST_RATE_LIMIT,
  canDecideCertificate,
  checkCertificateUpload,
} from '@peerchive/domain'
import { and, asc, certificateChecks, desc, eq, institutionAffiliations, institutionCohorts, isNotNull, isNull, schools, users, type DbExecutor } from '@peerchive/db'
import { ObjectNotFoundError, ObjectTooLargeError, enqueueCertificateScan, isObjectKey, newQuarantineKey, type ObjectStorage } from '@peerchive/files'
import { affiliationPepper } from '../affiliation/config'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, conflict, invalid, notFound, rateLimited, sqlState, tooLarge } from '../errors'
import { requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { constantTimeEqualHex } from '../security/tokens'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { affiliationDto, closeOpenRequests, findOrCreateCohort, loadNonUniversityInstitution, toInstitutionDto } from './institutions'
import type { AffiliationDto, CertificateFileUrlDto, CertificateRequestDto, OperatorCertificateCheckDto } from '../../../shared/types/api'

type CheckRow = typeof certificateChecks.$inferSelect

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const requestSchema = z.object({
  institutionId: z.string({ error: requiredOr('invalid') }),
  standing: z.enum(AFFILIATION_STANDINGS, { error: requiredOr('invalid') }),
  cohortLabel: z.unknown().optional(),
  declaredType: z.unknown(),
  fileName: z.unknown(),
  byteSize: z.unknown(),
})

export const certificateUploadUrl = (affiliationId: string) => `/api/v1/me/affiliations/${affiliationId}/certificate`

/** POST /me/affiliations/certificate — 201 + pending 소속·업로드 주소. 404(기관), 409 `already_verified`, 422(대학·형식·크기·기수), 429. */
export async function requestCertificateCheck(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<CertificateRequestDto> {
  requireFeature('institutions')
  const input = parseInput(requestSchema, rawInput)
  const file = checkCertificateUpload({ declaredType: input.declaredType, fileName: input.fileName, byteSize: input.byteSize })
  if (!file.ok) throw invalid({ [file.field]: file.reason })
  if (!(await hitRateLimit(db, 'institution_request_user', actor.userId, INSTITUTION_REQUEST_RATE_LIMIT, now))) throw rateLimited()
  try {
    const row = await db.transaction(async (tx) => {
      const institution = await loadNonUniversityInstitution(tx, input.institutionId)
      const hasCohort = !(input.cohortLabel === undefined || input.cohortLabel === null || input.cohortLabel === '')
      const cohort = hasCohort ? await findOrCreateCohort(tx, institution.id, input.cohortLabel, actor.userId) : null
      await closeOpenRequests(tx, actor.userId, institution.id, now)
      const [affiliation] = await tx
        .insert(institutionAffiliations)
        .values({
          userId: actor.userId,
          institutionKind: institution.kind,
          schoolId: institution.id,
          method: 'certificate_check',
          cohortId: cohort?.id ?? null,
          standing: input.standing,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      await tx.insert(certificateChecks).values({
        affiliationId: affiliation!.id,
        userId: actor.userId,
        objectKey: newQuarantineKey(),
        declaredType: file.mediaType,
        fileExtension: file.extension,
        byteSize: file.byteSize,
        createdAt: now,
      })
      return affiliation!
    })
    return { affiliation: await affiliationDto(db, row), uploadUrl: certificateUploadUrl(row.id) }
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('request_in_progress')
    throw error
  }
}

/**
 * PUT /me/affiliations/:id/certificate — 요청한 본인만. 200 + 소속. 선언 크기 초과 413, 모자람 422 `byteSize: size_mismatch`(받던 내용 삭제),
 * 이미 받음 409 `already_uploaded`, 요청이 끝났으면 409 `not_pending`. 받은 뒤 검사 작업을 남깁니다.
 */
export async function uploadCertificate(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  affiliationId: unknown,
  body: Readable | AsyncIterable<Uint8Array>,
  options: { contentLength?: number | null } = {},
  now = new Date(),
): Promise<AffiliationDto> {
  requireFeature('institutions')
  if (!isUuid(affiliationId)) throw notFound()
  const [found] = await db
    .select({ affiliation: institutionAffiliations, check: certificateChecks })
    .from(certificateChecks)
    .innerJoin(institutionAffiliations, eq(institutionAffiliations.id, certificateChecks.affiliationId))
    .where(eq(certificateChecks.affiliationId, affiliationId.toLowerCase()))
    .limit(1)
  if (!found || found.affiliation.userId !== actor.userId) throw notFound()
  const { check, affiliation } = found
  if (affiliation.status !== 'pending' || check.decidedAt || !check.objectKey) throw conflict('not_pending')
  if (check.uploadedAt) throw conflict('already_uploaded')
  const key = check.objectKey
  if (!isObjectKey(key)) throw new Error('invalid certificate key')
  const length = options.contentLength
  if (length != null && Number.isFinite(length)) {
    if (length > check.byteSize) throw tooLarge()
    if (length !== check.byteSize) throw invalid({ byteSize: 'size_mismatch' })
  }
  let result
  try {
    result = await storage.put(key, body, { maxBytes: check.byteSize })
  } catch (error) {
    if (error instanceof ObjectTooLargeError) throw tooLarge()
    if ((await storage.head(key)) !== null) throw conflict('already_uploaded')
    throw error
  }
  if (result.bytes !== check.byteSize) {
    await storage.delete(key)
    throw invalid({ byteSize: 'size_mismatch' })
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(certificateChecks)
      .set({ sha256: result.sha256, uploadedAt: now })
      .where(and(eq(certificateChecks.id, check.id), isNull(certificateChecks.uploadedAt), isNotNull(certificateChecks.objectKey)))
      .returning()
    if (row) await enqueueCertificateScan(tx, row.id)
    return row
  })
  if (!updated) throw conflict('already_uploaded')
  return affiliationDto(db, affiliation)
}

// ── 운영자 ───────────────────────────────────────────────────────────────

const listSchema = z.object({ status: z.enum(['pending', 'decided'], { error: 'invalid' }).optional() })

async function operatorDtos(db: DbExecutor, rows: CheckRow[]): Promise<OperatorCertificateCheckDto[]> {
  const out: OperatorCertificateCheckDto[] = []
  for (const c of rows) {
    const [r] = await db
      .select({
        affiliation: institutionAffiliations,
        school: schools,
        cohortLabel: institutionCohorts.label,
        displayName: users.displayName,
      })
      .from(institutionAffiliations)
      .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
      .innerJoin(users, eq(users.id, institutionAffiliations.userId))
      .leftJoin(institutionCohorts, eq(institutionCohorts.id, institutionAffiliations.cohortId))
      .where(eq(institutionAffiliations.id, c.affiliationId))
      .limit(1)
    if (!r) continue
    out.push({
      id: c.id,
      affiliationId: c.affiliationId,
      user: { id: r.affiliation.userId, displayName: r.displayName },
      institution: toInstitutionDto(r.school),
      cohortLabel: r.cohortLabel ?? null,
      standing: r.affiliation.standing,
      scanStatus: c.scanStatus,
      mediaType: c.mediaType,
      uploadedAt: c.uploadedAt?.toISOString() ?? null,
      viewable: !!c.objectKey && canDecideCertificate({ decidedAt: c.decidedAt, affiliationStatus: r.affiliation.status, scanStatus: c.scanStatus, filePurgedAt: c.filePurgedAt }),
      result: (c.result as 'approved' | 'rejected' | null) ?? null,
      decidedAt: c.decidedAt?.toISOString() ?? null,
      filePurgedAt: c.filePurgedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })
  }
  return out
}

/** GET /operator/certificate-checks?status=pending|decided — 운영자만. pending(기본): 결정 전·올린 것, 오래된 순. decided: 최근 결정 100개. */
export async function listCertificateChecks(db: DbExecutor, actor: Actor, query: unknown): Promise<OperatorCertificateCheckDto[]> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const q = parseInput(listSchema, query)
  const rows =
    q.status === 'decided'
      ? await db.select().from(certificateChecks).where(isNotNull(certificateChecks.decidedAt)).orderBy(desc(certificateChecks.decidedAt)).limit(100)
      : await db
          .select()
          .from(certificateChecks)
          .innerJoin(institutionAffiliations, eq(institutionAffiliations.id, certificateChecks.affiliationId))
          .where(and(isNull(certificateChecks.decidedAt), isNotNull(certificateChecks.uploadedAt), eq(institutionAffiliations.status, 'pending')))
          .orderBy(asc(certificateChecks.createdAt))
          .limit(100)
          .then((r) => r.map((x) => x.certificate_checks))
  return operatorDtos(db, rows)
}

async function loadCheckWithAffiliation(db: DbExecutor, checkId: unknown, lock = false) {
  if (!isUuid(checkId)) throw notFound()
  const query = db
    .select({ check: certificateChecks, affiliation: institutionAffiliations })
    .from(certificateChecks)
    .innerJoin(institutionAffiliations, eq(institutionAffiliations.id, certificateChecks.affiliationId))
    .where(eq(certificateChecks.id, checkId.toLowerCase()))
    .limit(1)
  const [found] = lock ? await query.for('update') : await query
  if (!found) throw notFound()
  return found
}

const viewable = (found: { check: CheckRow; affiliation: typeof institutionAffiliations.$inferSelect }) =>
  !!found.check.objectKey &&
  canDecideCertificate({
    decidedAt: found.check.decidedAt,
    affiliationStatus: found.affiliation.status,
    scanStatus: found.check.scanStatus,
    filePurgedAt: found.check.filePurgedAt,
  })

/** 서명: HMAC(affiliation pepper, 확인 id + 운영자 id + 만료). 다른 운영자·다른 파일·만료 뒤에는 맞지 않습니다. */
export function certificateFileSignature(pepper: string, checkId: string, operatorId: string, expiresAtMs: number): string {
  return createHmac('sha256', pepper).update(`certificate-file:v1:${checkId.toLowerCase()}:${operatorId.toLowerCase()}:${expiresAtMs}`).digest('hex')
}

/** POST /operator/certificate-checks/:id/file-url — 운영자만. 결정 전·검사 통과·파일 있음이 아니면 404. 60초 서명 URL, 감사 `certificate_check.view`. */
export async function certificateFileUrl(db: DbExecutor, actor: Actor, checkId: unknown, now = new Date()): Promise<CertificateFileUrlDto> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const found = await loadCheckWithAffiliation(db, checkId)
  if (!viewable(found)) throw notFound()
  const exp = now.getTime() + CERTIFICATE_FILE_URL_TTL_MS
  const sig = certificateFileSignature(affiliationPepper(), found.check.id, actor.userId, exp)
  await recordAudit(db, { actorId: actor.userId, action: 'certificate_check.view', targetType: 'certificate_check', targetId: found.check.id })
  return { url: `/api/v1/operator/certificate-checks/${found.check.id}/file?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp).toISOString() }
}

export interface CertificateFileContent {
  stream: Readable
  mediaType: string
  bytes: number
}

/** GET /operator/certificate-checks/:id/file?exp=&sig= — 운영자 + 맞는 서명 + 만료 전 + 결정 전 + 검사 통과 + 파일 있음. 그 밖은 모두 404. */
export async function openCertificateFile(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  checkId: unknown,
  query: { exp?: unknown; sig?: unknown },
  now = new Date(),
): Promise<CertificateFileContent> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const found = await loadCheckWithAffiliation(db, checkId)
  const exp = typeof query.exp === 'string' && /^\d{1,16}$/.test(query.exp) ? Number(query.exp) : NaN
  const sig = typeof query.sig === 'string' && /^[0-9a-f]{64}$/.test(query.sig) ? query.sig : null
  if (!Number.isFinite(exp) || !sig || exp <= now.getTime() || exp > now.getTime() + CERTIFICATE_FILE_URL_TTL_MS) throw notFound()
  if (!constantTimeEqualHex(sig, certificateFileSignature(affiliationPepper(), found.check.id, actor.userId, exp))) throw notFound()
  if (!viewable(found) || !found.check.mediaType || !isObjectKey(found.check.objectKey)) throw notFound()
  try {
    const stream = await storage.get(found.check.objectKey)
    return { stream, mediaType: found.check.mediaType, bytes: found.check.byteSize }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw notFound()
    throw error
  }
}

const decisionSchema = z.object({ result: z.enum(CERTIFICATE_RESULTS, { error: requiredOr('invalid') }) })

/**
 * POST /operator/certificate-checks/:id/decision {result} — 운영자만. 200. 이미 결정 409 `already_decided`, 요청이 끝났거나(취소·대체)
 * 검사 전·격리면 409 `not_reviewable`. 승인: 소속 active. 거절: 소속 revoked(`certificate_rejected`). 감사 `certificate_check.decide`.
 */
export async function decideCertificateCheck(db: DbExecutor, actor: Actor, checkId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorCertificateCheckDto> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const input = parseInput(decisionSchema, rawInput)
  const id = await db.transaction(async (tx) => {
    const found = await loadCheckWithAffiliation(tx, checkId, true)
    if (found.check.decidedAt) throw conflict('already_decided')
    if (!canDecideCertificate({ decidedAt: null, affiliationStatus: found.affiliation.status, scanStatus: found.check.scanStatus, filePurgedAt: found.check.filePurgedAt })) {
      throw conflict('not_reviewable')
    }
    await tx.update(certificateChecks).set({ result: input.result, reviewedBy: actor.userId, decidedAt: now }).where(eq(certificateChecks.id, found.check.id))
    if (input.result === 'approved') {
      await tx.update(institutionAffiliations).set({ status: 'active', verifiedAt: now, updatedAt: now }).where(eq(institutionAffiliations.id, found.affiliation.id))
      await emitAnalytics(tx, { name: 'affiliation_verified', actorId: found.affiliation.userId, props: { standing: found.affiliation.standing }, now })
    } else {
      await tx
        .update(institutionAffiliations)
        .set({ status: 'revoked', revokedAt: now, revokedReason: 'certificate_rejected', updatedAt: now })
        .where(eq(institutionAffiliations.id, found.affiliation.id))
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'certificate_check.decide',
      targetType: 'certificate_check',
      targetId: found.check.id,
      metadata: { result: input.result, schoolId: found.affiliation.schoolId, affiliationId: found.affiliation.id },
    })
    return found.check.id
  })
  const [row] = await db.select().from(certificateChecks).where(eq(certificateChecks.id, id)).limit(1)
  const [dto] = await operatorDtos(db, [row!])
  return dto!
}
