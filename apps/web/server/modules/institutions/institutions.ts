/**
 * 기관 일반화·초대 코드 (I-01, PROOFU_EVOLUTION_PLAN §8.9.11, SYSTEM_DESIGN §6.7.2·§8.4·§9.2, DELIVERY_PLAN §4.3 I-01·§5.3 Z, ADR 0037).
 *
 * 모든 함수는 P2 기능 플래그 `institutions`가 꺼져 있으면 404입니다(`requireFeature`). 기존 학교 메일 인증(C-01)은 플래그와 무관합니다.
 *
 * - 기관 = `schools` 행 + `kind`. 대학(university)은 학생이 만들고 학교 메일로만 인증합니다. 대학이 아닌 기관(부트캠프 등)은 운영자만 만들고
 *   (`POST /operator/institutions`, CLI `institution create`), 초대 코드·기수 승인·수료증 확인으로 인증합니다. 과목·학교 검색에는 나오지 않습니다.
 * - 초대 코드: 운영자가 발급(`POST /operator/institutions/:id/invite-codes`, CLI), 원문은 그 응답에만. HMAC(affiliation pepper)만 저장.
 *   I-02(ADR 0044): 그 기관의 운영진도 자기 기관 코드만 발급·목록·철회합니다(`/institutions/:id/invite-codes`, `/invite-codes/:id/revoke`).
 *   다른 기관은 403 `institution_staff_only`, 다른 기관 코드의 철회는 404(코드 id가 있는지도 모름).
 *   사용(`POST /me/affiliations/invite-code`)은 사용자·IP별 한도(맞든 틀리든 셈) 뒤, 철회 410 / 만료 410 / 한도 410, 없는 코드 422.
 *   성공하면 그 기관(·코드의 기수) active 소속(method invite_code). 같은 기관의 진행 중 요청은 대체(expired)되고, 이미 active면 409.
 */
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import {
  AFFILIATION_STANDINGS,
  INVITE_CODE_RATE_LIMITS,
  NON_UNIVERSITY_KINDS,
  checkInviteIssue,
  decideInviteRedemption,
  formatInviteCode,
  generateInviteCode,
  inviteCodeHashMessage,
  isNonUniversityKind,
  labelKey,
  normalizeCohortLabel,
  normalizeInstitutionName,
  normalizeInviteCode,
} from '@peerchive/domain'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  institutionAffiliations,
  institutionCohorts,
  institutionInviteCodes,
  isNull,
  schools,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { affiliationPepper } from '../affiliation/config'
import { toDto } from '../affiliation/affiliations'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { loadCanonicalSchool, type SchoolRow } from '../catalog/catalog'
import { isOperator, requireOperator } from '../catalog/operators'
import { type Actor, ServiceError, conflict, gone, invalid, notFound, rateLimited, sqlState } from '../errors'
import { requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { canManageInstitution, requireInstitutionManager } from './staff'
import type { AffiliationDto, InstitutionDto, InviteCodeDto, IssuedInviteCodeDto } from '../../../shared/types/api'

type AffiliationRow = typeof institutionAffiliations.$inferSelect
type CohortRow = typeof institutionCohorts.$inferSelect
type InviteRow = typeof institutionInviteCodes.$inferSelect

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const toInstitutionDto = (row: Pick<SchoolRow, 'id' | 'name' | 'kind'>): InstitutionDto => ({ id: row.id, name: row.name, kind: row.kind })

/** 초대 코드 HMAC(정규 코드). CLI(packages/db/scripts/institution.ts)도 같은 규칙입니다. */
export function hashInviteCode(pepper: string, normalizedCode: string): string {
  return createHmac('sha256', pepper).update(inviteCodeHashMessage(normalizedCode)).digest('hex')
}

/** 대학이 아닌 정본 기관. 없으면 404, 대학이면 422 `institutionId: not_supported`(대학은 학교 메일 인증만). */
export async function loadNonUniversityInstitution(db: DbExecutor, institutionId: unknown, field = 'institutionId'): Promise<SchoolRow> {
  const row = await loadCanonicalSchool(db, institutionId)
  if (!isNonUniversityKind(row.kind)) throw invalid({ [field]: 'not_supported' })
  return row
}

/** 기수 찾기(없으면 만들기). 같은 기관·같은 label_key는 같은 기수입니다. */
export async function findOrCreateCohort(db: DbExecutor, schoolId: string, rawLabel: unknown, createdBy: string | null, field = 'cohortLabel'): Promise<CohortRow> {
  const checked = normalizeCohortLabel(rawLabel)
  if (!checked.ok) throw invalid({ [field]: checked.reason })
  await db
    .insert(institutionCohorts)
    .values({ schoolId, label: checked.value, labelKey: checked.key, createdBy })
    .onConflictDoNothing({ target: [institutionCohorts.schoolId, institutionCohorts.labelKey] })
  const [row] = await db
    .select()
    .from(institutionCohorts)
    .where(and(eq(institutionCohorts.schoolId, schoolId), eq(institutionCohorts.labelKey, checked.key)))
    .limit(1)
  if (!row) throw new Error('cohort not found after insert')
  return row
}

/**
 * 새 인증을 만들기 전에 같은 사용자·기관의 진행 중 행을 정리합니다(잠금). active가 있으면 409 `already_verified`,
 * pending(어떤 수단이든)은 새 요청으로 대체해 expired로 끝냅니다(학교 메일 요청과 같은 규칙, 수료증 파일은 worker가 지움).
 */
export async function closeOpenRequests(tx: DbExecutor, userId: string, schoolId: string, now: Date): Promise<void> {
  const open = await tx
    .select()
    .from(institutionAffiliations)
    .where(and(eq(institutionAffiliations.userId, userId), eq(institutionAffiliations.schoolId, schoolId), inArray(institutionAffiliations.status, ['pending', 'active'])))
    .for('update')
  if (open.some((r) => r.status === 'active')) throw conflict('already_verified')
  if (open.length > 0) {
    await tx
      .update(institutionAffiliations)
      .set({ status: 'expired', emailHash: null, updatedAt: now })
      .where(inArray(institutionAffiliations.id, open.map((r) => r.id)))
  }
}

/** 소속 DTO(기관·기수 이름을 함께 읽음). */
export async function affiliationDto(db: DbExecutor, row: AffiliationRow): Promise<AffiliationDto> {
  return toDto(db, row)
}

// ── 기관 ─────────────────────────────────────────────────────────────────

const createInstitutionSchema = z.object({
  name: z.unknown(),
  kind: z.enum(NON_UNIVERSITY_KINDS, { error: requiredOr('invalid') }),
})

/**
 * POST /operator/institutions {name, kind} — 운영자만. 대학이 아닌 기관을 만듭니다(대학은 학생이 만드는 학교). 201.
 * 같은 이름 키의 정본 학교·기관이 있으면 409 `already_exists`(+기존 id·종류).
 */
export async function createInstitution(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<InstitutionDto> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const input = parseInput(createInstitutionSchema, rawInput)
  const name = normalizeInstitutionName(input.name)
  if (!name) throw invalid({ name: input.name === undefined ? 'required' : 'invalid' })
  const key = labelKey(name)
  if (!key) throw invalid({ name: 'invalid' })
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(schools).where(and(eq(schools.nameKey, key), isNull(schools.mergedInto))).limit(1)
    if (existing) throw conflict('already_exists', { candidates: [{ id: existing.id, name: existing.name, code: existing.kind }] })
    try {
      const row = await tx.transaction(async (sp) => {
        const [inserted] = await sp.insert(schools).values({ name, nameKey: key, kind: input.kind, createdBy: actor.userId, createdAt: now }).returning()
        return inserted!
      })
      await recordAudit(tx, { actorId: actor.userId, action: 'institution.create', targetType: 'school', targetId: row.id, metadata: { kind: row.kind } })
      return toInstitutionDto(row)
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('already_exists')
      throw error
    }
  })
}

const searchSchema = z.object({
  q: z.string({ error: 'invalid' }).max(100, { error: 'too_long' }).optional(),
  kind: z.enum(NON_UNIVERSITY_KINDS, { error: 'invalid' }).optional(),
})

/** GET /institutions?q=&kind= — 로그인 사용자. 대학이 아닌 정본 기관 검색(최대 20개, 이름순). q가 없으면 빈 목록. */
export async function searchInstitutions(db: DbExecutor, _actor: Actor, query: unknown): Promise<InstitutionDto[]> {
  requireFeature('institutions')
  const q = parseInput(searchSchema, query)
  const key = q.q ? labelKey(q.q) : ''
  if (!key) return []
  const rows = await db
    .select({ id: schools.id, name: schools.name, kind: schools.kind })
    .from(schools)
    .where(
      and(
        isNull(schools.mergedInto),
        q.kind ? eq(schools.kind, q.kind) : inArray(schools.kind, [...NON_UNIVERSITY_KINDS]),
        sql`(${schools.nameKey} like ${`%${key}%`} or ${schools.nameKey} % ${key})`,
      ),
    )
    .orderBy(sql`(${schools.nameKey} = ${key}) desc`, desc(sql`similarity(${schools.nameKey}, ${key})`), asc(schools.name))
    .limit(20)
  return rows.map(toInstitutionDto)
}

// ── 초대 코드 ────────────────────────────────────────────────────────────

const issueSchema = z.object({
  cohortLabel: z.unknown().optional(),
  maxUses: z.unknown(),
  expiresInDays: z.unknown().optional(),
})

async function inviteDtos(db: DbExecutor, rows: InviteRow[]): Promise<InviteCodeDto[]> {
  if (rows.length === 0) return []
  const schoolRows = await db.select().from(schools).where(inArray(schools.id, [...new Set(rows.map((r) => r.schoolId))]))
  const cohortIds = rows.map((r) => r.cohortId).filter((x): x is string => !!x)
  const cohortRows = cohortIds.length ? await db.select().from(institutionCohorts).where(inArray(institutionCohorts.id, cohortIds)) : []
  const schoolById = new Map(schoolRows.map((s) => [s.id, s]))
  const cohortById = new Map(cohortRows.map((c) => [c.id, c.label]))
  return rows.map((r) => ({
    id: r.id,
    institution: toInstitutionDto(schoolById.get(r.schoolId)!),
    cohortLabel: r.cohortId ? (cohortById.get(r.cohortId) ?? null) : null,
    expiresAt: r.expiresAt.toISOString(),
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

interface IssueInput {
  cohortLabel?: unknown
  maxUses?: unknown
  expiresInDays?: unknown
}

/** 발급 본체(운영자·운영진 공통). 기관은 호출자가 확인한 대학이 아닌 정본 기관. 감사 `byStaff`는 운영진으로서 발급했는지. */
async function issueCodeFor(db: DbExecutor, actorId: string, institution: SchoolRow, input: IssueInput, byStaff: boolean, now: Date): Promise<IssuedInviteCodeDto> {
  const checked = checkInviteIssue({ maxUses: input.maxUses, expiresInDays: input.expiresInDays }, now)
  if (!checked.ok) throw invalid({ [checked.field]: checked.reason })
  const pepper = affiliationPepper()
  const code = generateInviteCode()
  const normalized = normalizeInviteCode(code)!
  return db.transaction(async (tx) => {
    const cohort = input.cohortLabel === undefined || input.cohortLabel === null || input.cohortLabel === '' ? null : await findOrCreateCohort(tx, institution.id, input.cohortLabel, actorId)
    const [row] = await tx
      .insert(institutionInviteCodes)
      .values({
        schoolId: institution.id,
        cohortId: cohort?.id ?? null,
        codeHash: hashInviteCode(pepper, normalized),
        issuedBy: actorId,
        expiresAt: checked.expiresAt,
        maxUses: checked.maxUses,
        createdAt: now,
      })
      .returning()
    await recordAudit(tx, {
      actorId,
      action: 'invite_code.issue',
      targetType: 'invite_code',
      targetId: row!.id,
      metadata: { schoolId: institution.id, cohort: cohort !== null, maxUses: checked.maxUses, byStaff },
    })
    const [dto] = await inviteDtos(tx, [row!])
    return { ...dto!, code: formatInviteCode(normalized) }
  })
}

async function codesOf(db: DbExecutor, institutionId: string): Promise<InviteCodeDto[]> {
  const rows = await db
    .select()
    .from(institutionInviteCodes)
    .where(eq(institutionInviteCodes.schoolId, institutionId))
    .orderBy(desc(institutionInviteCodes.createdAt), desc(institutionInviteCodes.id))
    .limit(100)
  return inviteDtos(db, rows)
}

/** 철회 본체(잠금, 멱등). `allowed`가 false면 404(코드가 있는지도 드러내지 않음). */
async function revokeCode(db: DbExecutor, actor: Actor, codeId: unknown, now: Date, allowed: (schoolId: string) => Promise<boolean>, byStaff: boolean): Promise<InviteCodeDto> {
  if (!isUuid(codeId)) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(institutionInviteCodes).where(eq(institutionInviteCodes.id, codeId.toLowerCase())).limit(1).for('update')
    if (!row || !(await allowed(row.schoolId))) throw notFound()
    let current = row
    if (!row.revokedAt) {
      const [updated] = await tx.update(institutionInviteCodes).set({ revokedAt: now }).where(eq(institutionInviteCodes.id, row.id)).returning()
      current = updated!
      await recordAudit(tx, { actorId: actor.userId, action: 'invite_code.revoke', targetType: 'invite_code', targetId: row.id, metadata: { schoolId: row.schoolId, byStaff } })
    }
    const [dto] = await inviteDtos(tx, [current])
    return dto!
  })
}

/**
 * POST /operator/institutions/:id/invite-codes {maxUses, expiresInDays?, cohortLabel?} — 운영자만. 201 + 원문 코드(이 응답에만).
 * 대학이면 422 `institutionId: not_supported`. 사용 한도 1–1000, 유효 기간 1–90일(기본 14).
 */
export async function issueInviteCode(db: DbExecutor, actor: Actor, institutionId: unknown, rawInput: unknown, now = new Date()): Promise<IssuedInviteCodeDto> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const input = parseInput(issueSchema, rawInput)
  const institution = await loadNonUniversityInstitution(db, institutionId)
  return issueCodeFor(db, actor.userId, institution, input, false, now)
}

/** GET /operator/institutions/:id/invite-codes — 운영자만. 최근 100개(원문 없음). */
export async function listInviteCodes(db: DbExecutor, actor: Actor, institutionId: unknown): Promise<InviteCodeDto[]> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const institution = await loadCanonicalSchool(db, institutionId)
  return codesOf(db, institution.id)
}

/** POST /operator/invite-codes/:id/revoke — 운영자만. 200(이미 철회했어도 200). 이미 만든 소속은 그대로입니다. */
export async function revokeInviteCode(db: DbExecutor, actor: Actor, codeId: unknown, now = new Date()): Promise<InviteCodeDto> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  return revokeCode(db, actor, codeId, now, async () => true, false)
}

/**
 * POST /institutions/:id/invite-codes {maxUses, expiresInDays?, cohortLabel?} — 그 기관 운영진(또는 운영자, I-02). 201 + 원문 코드(이 응답에만).
 * 다른 기관 403 `institution_staff_only`, 대학 422 `institutionId: not_supported`. 규칙은 운영자 발급과 같습니다.
 */
export async function issueStaffInviteCode(db: DbExecutor, actor: Actor, institutionId: unknown, rawInput: unknown, now = new Date()): Promise<IssuedInviteCodeDto> {
  requireFeature('institutions')
  const manager = await requireInstitutionManager(db, actor, institutionId)
  const input = parseInput(issueSchema, rawInput)
  return issueCodeFor(db, actor.userId, manager.institution, input, !manager.operator, now)
}

/** GET /institutions/:id/invite-codes — 그 기관 운영진(또는 운영자). 그 기관 코드 최근 100개(원문 없음). */
export async function listStaffInviteCodes(db: DbExecutor, actor: Actor, institutionId: unknown): Promise<InviteCodeDto[]> {
  requireFeature('institutions')
  const manager = await requireInstitutionManager(db, actor, institutionId)
  return codesOf(db, manager.institution.id)
}

/** POST /invite-codes/:id/revoke — 그 코드 기관의 운영진(또는 운영자). 200(멱등). 다른 기관 코드·없는 코드는 404. */
export async function revokeStaffInviteCode(db: DbExecutor, actor: Actor, codeId: unknown, now = new Date()): Promise<InviteCodeDto> {
  requireFeature('institutions')
  const operator = await isOperator(db, actor.userId)
  return revokeCode(db, actor, codeId, now, (schoolId) => canManageInstitution(db, actor, schoolId), !operator)
}

const redeemSchema = z.object({
  code: z.unknown(),
  standing: z.enum(AFFILIATION_STANDINGS, { error: requiredOr('invalid') }),
})

export interface InviteRedeemContext {
  ip: string
  now?: Date
}

/**
 * POST /me/affiliations/invite-code {code, standing} — 201 + active 소속(method invite_code).
 * 429(사용자 10회·IP 30회/시간, 맞든 틀리든 셈), 422 `code: invalid_format`(세지 않음)·`invite_code_invalid`(없는 코드),
 * 410 `invite_code_revoked`·`invite_code_expired`·`invite_code_exhausted`, 409 `already_verified`.
 */
export async function redeemInviteCode(db: DbExecutor, actor: Actor, rawInput: unknown, ctx: InviteRedeemContext): Promise<AffiliationDto> {
  requireFeature('institutions')
  const now = ctx.now ?? new Date()
  const input = parseInput(redeemSchema, rawInput)
  const normalized = normalizeInviteCode(input.code)
  if (!normalized) throw invalid({ code: 'invalid_format' })
  if (!(await hitRateLimit(db, 'invite_code_ip', ctx.ip, INVITE_CODE_RATE_LIMITS.perIp, now))) throw rateLimited()
  if (!(await hitRateLimit(db, 'invite_code_user', actor.userId, INVITE_CODE_RATE_LIMITS.perUser, now))) throw rateLimited()
  const codeHash = hashInviteCode(affiliationPepper(), normalized)

  type Outcome = { kind: 'ok'; row: AffiliationRow } | { kind: 'rejected'; reason: 'invite_code_revoked' | 'invite_code_expired' | 'invite_code_exhausted' } | { kind: 'invalid' }
  let outcome: Outcome
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [code] = await tx.select().from(institutionInviteCodes).where(eq(institutionInviteCodes.codeHash, codeHash)).limit(1).for('update')
      if (!code) return { kind: 'invalid' }
      const decision = decideInviteRedemption(code, now)
      if (!decision.ok) return { kind: 'rejected', reason: decision.reason }
      const institution = await loadCanonicalSchool(tx, code.schoolId)
      await closeOpenRequests(tx, actor.userId, institution.id, now)
      const [row] = await tx
        .insert(institutionAffiliations)
        .values({
          userId: actor.userId,
          institutionKind: institution.kind,
          schoolId: institution.id,
          method: 'invite_code',
          cohortId: code.cohortId,
          standing: input.standing,
          status: 'active',
          verifiedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      await tx.update(institutionInviteCodes).set({ usedCount: code.usedCount + 1 }).where(eq(institutionInviteCodes.id, code.id))
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'affiliation.verify',
        targetType: 'affiliation',
        targetId: row!.id,
        metadata: { schoolId: institution.id, method: 'invite_code', standing: input.standing, inviteCodeId: code.id },
      })
      await emitAnalytics(tx, { name: 'affiliation_verified', actorId: actor.userId, props: { standing: input.standing }, now })
      return { kind: 'ok', row: row! }
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('request_in_progress')
    throw error
  }
  if (outcome.kind === 'invalid') throw new ServiceError('VALIDATION', 'invite_code_invalid', { code: 'invite_code_invalid' })
  if (outcome.kind === 'rejected') throw gone(outcome.reason)
  return affiliationDto(db, outcome.row)
}
