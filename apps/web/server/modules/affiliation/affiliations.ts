/**
 * 학교 메일 인증·학과 자기 신고 (C-01, PROOFU_EVOLUTION_PLAN §8.6, SYSTEM_DESIGN §6.7 SchoolAffiliation·§8.1·§9.1, DELIVERY_PLAN §4.1 C-01, ADR 0018).
 *
 * 흐름(로그인 필요)
 * 1. `POST /me/affiliations {schoolId, email, standing, departmentLabel?}`: 메일 도메인이 그 학교(정본)의 등록 도메인(또는 하위 도메인)이 아니면
 *    422 `domain_not_allowed`(다른 학교 도메인은 알려 주지 않음). IP·사용자별 한도는 429. 통과하면 pending 행과 6자리 코드(HMAC만 저장, 10분)를
 *    만들고 메일을 보낸 뒤 **202**. 그 주소가 다른 계정에서 이미 인증됐는지는 여기서 확인하지 않고(열거 방지), 주소별 한도를 넘어도 같은 202에
 *    발송만 하지 않습니다. 메일 주소는 저장하지 않습니다(HMAC + 도메인만).
 * 2. `POST /me/affiliations/:id/verify {code}`: 상수 시간 비교. 틀리면 422 `code_mismatch`(+attemptsLeft), 5번째로 틀리면 410 `attempts_exceeded`,
 *    만료 410 `code_expired`. 맞으면 active. 이때 같은 주소가 다른 계정에서 active면 409 `email_in_use` — 코드로 주소 소유가 증명된 뒤에만
 *    알려 주므로, 남의 주소가 쓰이는지 알아보는 데 쓸 수 없습니다.
 * 3. `PATCH /me/affiliations/:id {standing?, departmentLabel?}`: 재학생 → 졸업생만. `DELETE /me/affiliations/:id`: 해제(revoked, 메일 해시 삭제, 이력 유지).
 * 운영자: `POST /operator/affiliations/:id/revoke {reason}`(감사), `GET /operator/affiliations?schoolId=|userId=`(사용자 id·학교·도메인·상태만).
 *
 * 졸업 뒤 학교 메일이 없어져도 active를 유지합니다(주기적 재인증 없음). 과목 허브 작성 자격은 active 행으로 판정합니다(`activeAffiliationSchoolIds`).
 */
import { createHmac, randomInt } from 'node:crypto'
import { z } from 'zod'
import {
  AFFILIATION_CODE_MAX_ATTEMPTS,
  AFFILIATION_CODE_TTL_MS,
  AFFILIATION_RATE_LIMITS,
  AFFILIATION_STANDINGS,
  AFFILIATION_STATUSES,
  affiliationBadgeLabel,
  canChangeStanding,
  decideCodeAttempt,
  normalizeAffiliationCode,
  normalizeDepartmentLabel,
  parseSchoolEmail,
  type AffiliationStanding,
} from '@peerchive/domain'
import {
  affiliationCodes,
  and,
  desc,
  eq,
  inArray,
  institutionAffiliations,
  ne,
  profiles,
  schools,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { loadCanonicalSchool } from '../catalog/catalog'
import { requireOperator } from '../catalog/operators'
import { type Actor, ServiceError, conflict, gone, invalid, notFound, rateLimited, sqlState } from '../errors'
import { describeMailError, type MailTransport } from '../identity/mail'
import { isUuid } from '../projects/access'
import { constantTimeEqualHex } from '../security/tokens'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { affiliationPepper, hubWritePolicy } from './config'
import { matchSchoolDomain } from './domains'
import type {
  AffiliationDto,
  AffiliationListDto,
  AffiliationRevokedReason,
  OperatorAffiliationDto,
  PublicAffiliationBadgeDto,
} from '../../../shared/types/api'

type AffiliationRow = typeof institutionAffiliations.$inferSelect
type CodeRow = typeof affiliationCodes.$inferSelect

// ── 해시 ─────────────────────────────────────────────────────────────────

/** 정규 학교 메일 주소(`+태그` 제거)의 HMAC-SHA256. 한 주소 한 계정 확인에만 씁니다. */
export function hashSchoolEmail(pepper: string, canonicalAddress: string): string {
  return createHmac('sha256', pepper).update(`school-email:v1:${canonicalAddress.toLowerCase()}`).digest('hex')
}

/** 인증 코드의 HMAC. 소속 id를 섞어 다른 행의 해시와 바꿔 쓸 수 없게 합니다. */
export function hashAffiliationCode(pepper: string, affiliationId: string, code: string): string {
  return createHmac('sha256', pepper).update(`affiliation-code:v1:${affiliationId.toLowerCase()}:${code}`).digest('hex')
}

/** CSPRNG 6자리(앞자리 0 포함). */
export function generateAffiliationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

// ── DTO ──────────────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

/** 소속 행 + 정본 학교 이름(병합 전 행이어도 정본으로). */
async function loadRows(db: DbExecutor, where: ReturnType<typeof and>) {
  return db
    .select({
      row: institutionAffiliations,
      schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
      schoolName: sql<string>`coalesce((select c.name from schools c where c.id = ${schools.mergedInto}), ${schools.name})`,
    })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(where)
    .orderBy(desc(institutionAffiliations.createdAt), desc(institutionAffiliations.id))
}

async function latestCode(db: DbExecutor, affiliationId: string, lock = false): Promise<CodeRow | undefined> {
  const query = db
    .select()
    .from(affiliationCodes)
    .where(eq(affiliationCodes.affiliationId, affiliationId))
    .orderBy(desc(affiliationCodes.createdAt), desc(affiliationCodes.id))
    .limit(1)
  return (lock ? await query.for('update') : await query)[0]
}

async function toDto(db: DbExecutor, row: AffiliationRow, school?: { id: string; name: string }): Promise<AffiliationDto> {
  let s: { id: string; name: string }
  if (school) s = school
  else {
    const [loaded] = await loadRows(db, and(eq(institutionAffiliations.id, row.id)))
    s = { id: loaded!.schoolId, name: loaded!.schoolName }
  }
  let code: AffiliationDto['code'] = null
  if (row.status === 'pending') {
    const c = await latestCode(db, row.id)
    if (c && !c.usedAt) code = { expiresAt: c.expiresAt.toISOString(), attemptsLeft: Math.max(0, AFFILIATION_CODE_MAX_ATTEMPTS - c.attempts) }
  }
  return {
    id: row.id,
    school: s,
    emailDomain: row.emailDomain,
    standing: row.standing,
    departmentLabel: row.departmentLabel,
    status: row.status,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: (row.revokedReason as AffiliationRevokedReason | null) ?? null,
    code,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function parseDepartment(raw: unknown): string | null {
  const checked = normalizeDepartmentLabel(raw)
  if (!checked.ok) throw invalid({ departmentLabel: checked.reason })
  return checked.value
}

/** 행을 끝냅니다(만료·해제·취소): 메일 해시를 지우고 이력(학교·도메인·인증 시각)만 남깁니다. */
const closedFields = (status: 'expired' | 'revoked', now: Date, reason?: AffiliationRevokedReason) => ({
  status,
  emailHash: null,
  updatedAt: now,
  ...(status === 'revoked' && { revokedAt: now, revokedReason: reason ?? 'user_removed' }),
})

// ── 요청 ─────────────────────────────────────────────────────────────────

export const requestAffiliationSchema = z.object({
  schoolId: z.string({ error: requiredOr('invalid') }),
  email: z.string({ error: requiredOr('invalid') }).max(254, { error: 'too_long' }),
  standing: z.enum(AFFILIATION_STANDINGS, { error: requiredOr('invalid') }),
  departmentLabel: z.unknown().optional(),
})

export interface AffiliationRequestContext {
  /** 요청 IP. 알 수 없으면 'unknown'. */
  ip: string
  mail: MailTransport
  now?: Date
}

/** 인증 코드 메일(일반 텍스트 + 같은 내용의 단순 HTML). 주소·학교 이름은 넣지 않습니다. */
export function affiliationCodeMail(code: string): { subject: string; text: string; html: string } {
  const intro = 'Peerchive 학교 메일 인증 코드입니다.'
  const usage = '이 코드는 10분 동안 쓸 수 있습니다. Peerchive의 학교 인증 화면에 입력하세요.'
  const outro = '직접 요청하지 않았다면 이 메일을 무시하세요. 코드를 입력하지 않으면 아무 일도 일어나지 않습니다.'
  return {
    subject: 'Peerchive 학교 메일 인증 코드',
    text: [intro, '', `인증 코드: ${code}`, '', usage, outro].join('\n'),
    html: [
      '<!doctype html>',
      '<html lang="ko"><head><meta charset="utf-8"><title>Peerchive 학교 메일 인증 코드</title></head>',
      '<body style="font-family:sans-serif;line-height:1.6;color:#222">',
      `<p>${intro}</p>`,
      `<p style="font-size:22px;letter-spacing:4px"><strong>인증 코드: ${code}</strong></p>`,
      `<p>${usage}</p>`,
      `<p style="font-size:13px;color:#555">${outro}</p>`,
      '</body></html>',
    ].join('\n'),
  }
}

/**
 * POST /me/affiliations — 202 + pending 소속(코드 만료 시각·남은 시도). 404(없는 학교), 409 `already_verified`(이 학교 인증이 이미 active),
 * 422(`email: invalid_format`, `domain_not_allowed`, `departmentLabel`), 429(IP·사용자별 한도).
 */
export async function requestAffiliation(db: DbExecutor, actor: Actor, rawInput: unknown, ctx: AffiliationRequestContext): Promise<AffiliationDto> {
  const now = ctx.now ?? new Date()
  const input = parseInput(requestAffiliationSchema, rawInput)
  const email = parseSchoolEmail(input.email)
  if (!email) throw invalid({ email: 'invalid_format' })
  const departmentLabel = parseDepartment(input.departmentLabel)
  const school = await loadCanonicalSchool(db, input.schoolId)
  const pepper = affiliationPepper()

  // 한도는 업무 트랜잭션 밖에서 셉니다(도메인 거부 422도 횟수에 들어가 도메인 추측을 제한).
  if (!(await hitRateLimit(db, 'affiliation_ip', ctx.ip, AFFILIATION_RATE_LIMITS.perIp, now))) throw rateLimited()
  if (!(await hitRateLimit(db, 'affiliation_user', actor.userId, AFFILIATION_RATE_LIMITS.perUser, now))) throw rateLimited()

  if (!(await matchSchoolDomain(db, school.id, email.domain))) {
    throw new ServiceError('VALIDATION', 'domain_not_allowed', { email: 'domain_not_allowed' })
  }
  const emailHash = hashSchoolEmail(pepper, email.canonical)
  // 주소별 한도를 넘으면 응답은 같고 발송만 하지 않습니다(그 주소가 쓰이는지·누가 요청했는지 드러내지 않음).
  const sendAllowed = await hitRateLimit(db, 'affiliation_address', emailHash, AFFILIATION_RATE_LIMITS.perAddress, now)
  const code = generateAffiliationCode()

  let created: AffiliationRow
  try {
    created = await db.transaction(async (tx) => {
      const open = await tx
        .select()
        .from(institutionAffiliations)
        .where(
          and(
            eq(institutionAffiliations.userId, actor.userId),
            eq(institutionAffiliations.schoolId, school.id),
            inArray(institutionAffiliations.status, ['pending', 'active']),
          ),
        )
        .for('update')
      if (open.some((r) => r.status === 'active')) throw conflict('already_verified')
      // 같은 학교의 이전 요청은 새 요청으로 대체합니다(이전 코드는 더 쓸 수 없음).
      if (open.length > 0) {
        await tx.update(institutionAffiliations).set(closedFields('expired', now)).where(inArray(institutionAffiliations.id, open.map((r) => r.id)))
      }
      const [row] = await tx
        .insert(institutionAffiliations)
        .values({
          userId: actor.userId,
          schoolId: school.id,
          emailHash,
          emailDomain: email.domain,
          standing: input.standing,
          departmentLabel,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      await tx.insert(affiliationCodes).values({
        affiliationId: row!.id,
        codeHash: hashAffiliationCode(pepper, row!.id, code),
        expiresAt: new Date(now.getTime() + AFFILIATION_CODE_TTL_MS),
        createdAt: now,
      })
      return row!
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('request_in_progress')
    throw error
  }

  if (sendAllowed) {
    // 발송 실패도 같은 202입니다. 실패는 가린 오류 코드만 로그·감사에 남깁니다(ADR 0017). 사용자는 다시 요청할 수 있습니다.
    try {
      await ctx.mail.send({ to: email.address, ...affiliationCodeMail(code) })
    } catch (error) {
      const { code: errorCode, responseCode } = describeMailError(error)
      console.error(`[affiliation] code mail failed (transport=${ctx.mail.name}, code=${errorCode}, responseCode=${responseCode ?? '-'})`)
      await recordAudit(db, {
        actorId: null,
        action: 'mail.send_failed',
        targetType: 'mail',
        metadata: { purpose: 'affiliation_code', transport: ctx.mail.name, code: errorCode, responseCode },
      }).catch(() => {})
    }
  }
  return toDto(db, created, { id: school.id, name: school.name })
}

// ── 코드 확인 ────────────────────────────────────────────────────────────

const verifySchema = z.object({ code: z.unknown() })

type VerifyOutcome =
  | { kind: 'ok'; dto: AffiliationDto }
  | { kind: 'mismatch'; attemptsLeft: number }
  | { kind: 'gone'; reason: 'code_expired' | 'attempts_exceeded' | 'code_unavailable' }
  | { kind: 'in_use' }

/** 내 소속 행을 잠그고 읽습니다. 다른 사람 것이면 404. */
async function loadOwn(tx: DbExecutor, actor: Actor, affiliationId: unknown): Promise<AffiliationRow> {
  if (!isUuid(affiliationId)) throw notFound()
  const [row] = await tx
    .select()
    .from(institutionAffiliations)
    .where(eq(institutionAffiliations.id, affiliationId.toLowerCase()))
    .limit(1)
    .for('update')
  if (!row || row.userId !== actor.userId) throw notFound()
  return row
}

/**
 * POST /me/affiliations/:id/verify {code} — 200 + active 소속(이미 active면 그대로 200). 404(내 것 아님), 422 `code: invalid_format`·
 * `code_mismatch`(+attemptsLeft), 410 `code_expired`·`attempts_exceeded`·`code_unavailable`, 409 `email_in_use`(코드로 소유가 증명된 뒤에만).
 * 틀린 시도·만료·잠김 상태는 커밋한 뒤 오류를 돌려줍니다.
 */
export async function verifyAffiliation(db: DbExecutor, actor: Actor, affiliationId: unknown, rawInput: unknown, now = new Date()): Promise<AffiliationDto> {
  const input = parseInput(verifySchema, rawInput)
  const code = normalizeAffiliationCode(input.code)
  if (!code) throw invalid({ code: 'invalid_format' })
  const pepper = affiliationPepper()
  let outcome: VerifyOutcome
  try {
    outcome = await db.transaction(async (tx): Promise<VerifyOutcome> => {
      const row = await loadOwn(tx, actor, affiliationId)
      if (row.status === 'active') return { kind: 'ok', dto: await toDto(tx, row) }
      if (row.status !== 'pending') return { kind: 'gone', reason: 'code_unavailable' }
      const current = await latestCode(tx, row.id, true)
      if (!current) return { kind: 'gone', reason: 'code_unavailable' }
      const matched = constantTimeEqualHex(current.codeHash, hashAffiliationCode(pepper, row.id, code))
      const decision = decideCodeAttempt(current, matched, now)
      switch (decision.kind) {
        case 'used':
          return { kind: 'gone', reason: 'code_unavailable' }
        case 'expired':
          await tx.update(institutionAffiliations).set(closedFields('expired', now)).where(eq(institutionAffiliations.id, row.id))
          return { kind: 'gone', reason: 'code_expired' }
        case 'locked':
          await tx.update(affiliationCodes).set({ attempts: decision.attempts }).where(eq(affiliationCodes.id, current.id))
          await tx.update(institutionAffiliations).set(closedFields('expired', now)).where(eq(institutionAffiliations.id, row.id))
          return { kind: 'gone', reason: 'attempts_exceeded' }
        case 'mismatch':
          await tx.update(affiliationCodes).set({ attempts: decision.attempts }).where(eq(affiliationCodes.id, current.id))
          return { kind: 'mismatch', attemptsLeft: decision.attemptsLeft }
        case 'verified': {
          await tx.update(affiliationCodes).set({ usedAt: now }).where(eq(affiliationCodes.id, current.id))
          // 같은 주소가 다른 계정(또는 다른 행)에서 이미 active면 이 요청을 끝냅니다. 코드로 주소 소유가 증명된 뒤라 알려 줘도 됩니다.
          const [taken] = await tx
            .select({ id: institutionAffiliations.id })
            .from(institutionAffiliations)
            .where(and(eq(institutionAffiliations.emailHash, row.emailHash!), eq(institutionAffiliations.status, 'active'), ne(institutionAffiliations.id, row.id)))
            .limit(1)
          if (taken) {
            await tx.update(institutionAffiliations).set(closedFields('expired', now)).where(eq(institutionAffiliations.id, row.id))
            return { kind: 'in_use' }
          }
          const [updated] = await tx
            .update(institutionAffiliations)
            .set({ status: 'active', verifiedAt: now, updatedAt: now })
            .where(eq(institutionAffiliations.id, row.id))
            .returning()
          await recordAudit(tx, {
            actorId: actor.userId,
            action: 'affiliation.verify',
            targetType: 'affiliation',
            targetId: row.id,
            metadata: { schoolId: row.schoolId, standing: row.standing, emailDomain: row.emailDomain },
          })
          await emitAnalytics(tx, { name: 'affiliation_verified', actorId: actor.userId, props: { standing: row.standing }, now })
          return { kind: 'ok', dto: await toDto(tx, updated!) }
        }
      }
    })
  } catch (error) {
    // 동시에 같은 주소를 인증한 경우(부분 unique 위반).
    if (sqlState(error) === '23505') throw conflict('email_in_use')
    throw error
  }
  switch (outcome.kind) {
    case 'ok':
      return outcome.dto
    case 'mismatch':
      throw new ServiceError('VALIDATION', 'code_mismatch', { code: 'code_mismatch' }, { attemptsLeft: outcome.attemptsLeft })
    case 'gone':
      throw gone(outcome.reason)
    case 'in_use':
      throw conflict('email_in_use')
  }
}

// ── 목록·수정·해제 ───────────────────────────────────────────────────────

/** GET /me/affiliations — 내 소속(만료된 요청은 빼고 최근 순) + 배지 설정 + 허브 작성 정책. */
export async function listMyAffiliations(db: DbExecutor, actor: Actor): Promise<AffiliationListDto> {
  const rows = await loadRows(db, and(eq(institutionAffiliations.userId, actor.userId), ne(institutionAffiliations.status, 'expired')))
  const items = await Promise.all(rows.map((r) => toDto(db, r.row, { id: r.schoolId, name: r.schoolName })))
  const [profile] = await db.select({ show: profiles.showAffiliationBadge }).from(profiles).where(eq(profiles.userId, actor.userId)).limit(1)
  return { items, showBadge: profile?.show ?? false, hubRequiresAffiliation: hubWritePolicy().requireAffiliation }
}

export const updateAffiliationSchema = z.object({
  standing: z.enum(AFFILIATION_STANDINGS, { error: 'invalid' }).optional(),
  departmentLabel: z.unknown().optional(),
})

/** PATCH /me/affiliations/:id {standing?, departmentLabel?} — 200. 404(내 것 아님), 409 `not_editable`(해제·만료), 422 `standing: not_allowed`(졸업생 → 재학생). */
export async function updateAffiliation(db: DbExecutor, actor: Actor, affiliationId: unknown, rawInput: unknown, now = new Date()): Promise<AffiliationDto> {
  const input = parseInput(updateAffiliationSchema, rawInput)
  const departmentLabel = input.departmentLabel === undefined ? undefined : parseDepartment(input.departmentLabel)
  return db.transaction(async (tx) => {
    const row = await loadOwn(tx, actor, affiliationId)
    if (row.status !== 'active' && row.status !== 'pending') throw conflict('not_editable')
    const standing: AffiliationStanding = input.standing ?? row.standing
    if (!canChangeStanding(row.standing, standing)) throw invalid({ standing: 'not_allowed' })
    const standingChanged = standing !== row.standing
    const departmentChanged = departmentLabel !== undefined && departmentLabel !== row.departmentLabel
    if (!standingChanged && !departmentChanged) return toDto(tx, row)
    const [updated] = await tx
      .update(institutionAffiliations)
      .set({ standing, ...(departmentLabel !== undefined && { departmentLabel }), updatedAt: now })
      .where(eq(institutionAffiliations.id, row.id))
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'affiliation.update',
      targetType: 'affiliation',
      targetId: row.id,
      // 학과 이름은 감사 기록에도 남기지 않습니다(바뀌었는지만).
      metadata: { standing, standingChanged, departmentChanged },
    })
    return toDto(tx, updated!)
  })
}

/** DELETE /me/affiliations/:id — 200 + revoked 소속(메일 해시 삭제, 학교·도메인·인증 시각 이력 유지). 이미 끝난 행도 200. */
export async function removeAffiliation(db: DbExecutor, actor: Actor, affiliationId: unknown, now = new Date()): Promise<AffiliationDto> {
  return db.transaction(async (tx) => {
    const row = await loadOwn(tx, actor, affiliationId)
    if (row.status !== 'active' && row.status !== 'pending') return toDto(tx, row)
    const [updated] = await tx
      .update(institutionAffiliations)
      .set(closedFields('revoked', now, 'user_removed'))
      .where(eq(institutionAffiliations.id, row.id))
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'affiliation.remove',
      targetType: 'affiliation',
      targetId: row.id,
      metadata: { schoolId: row.schoolId, wasActive: row.status === 'active' },
    })
    return toDto(tx, updated!)
  })
}

// ── 운영자 ───────────────────────────────────────────────────────────────

const operatorListSchema = z
  .object({
    schoolId: z.uuid({ error: 'invalid' }).optional(),
    userId: z.uuid({ error: 'invalid' }).optional(),
    status: z.enum(AFFILIATION_STATUSES, { error: 'invalid' }).optional(),
  })
  .refine((q) => q.schoolId || q.userId, { error: 'required', path: ['schoolId'] })

const toOperatorDto = (r: { row: AffiliationRow; schoolId: string; schoolName: string }): OperatorAffiliationDto => ({
  id: r.row.id,
  userId: r.row.userId,
  school: { id: r.schoolId, name: r.schoolName },
  emailDomain: r.row.emailDomain,
  status: r.row.status,
  verifiedAt: r.row.verifiedAt?.toISOString() ?? null,
  revokedAt: r.row.revokedAt?.toISOString() ?? null,
})

/** GET /operator/affiliations?schoolId=|userId=&status= — 운영자만. 최근 200개. 사용자 id·학교·도메인·상태·시각만(학과·재학 상태·메일 없음). */
export async function listAffiliationsForOperator(db: DbExecutor, actor: Actor, query: unknown): Promise<OperatorAffiliationDto[]> {
  await requireOperator(db, actor)
  const q = parseInput(operatorListSchema, query)
  let schoolFilter
  if (q.schoolId) {
    const school = await loadCanonicalSchool(db, q.schoolId)
    schoolFilter = sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${school.id}`
  }
  const rows = await loadRows(
    db,
    and(
      schoolFilter,
      q.userId ? eq(institutionAffiliations.userId, q.userId.toLowerCase()) : undefined,
      q.status ? eq(institutionAffiliations.status, q.status) : undefined,
    ),
  )
  return rows.slice(0, 200).map(toOperatorDto)
}

const revokeSchema = z.object({
  reason: z.string({ error: requiredOr('invalid') }).trim().min(1, { error: 'required' }).max(500, { error: 'too_long' }),
})

/** POST /operator/affiliations/:id/revoke {reason} — 운영자만(403). 200(이미 끝난 행도 200). 없으면 404. 감사 `affiliation.revoke`. */
export async function revokeAffiliationByOperator(
  db: DbExecutor,
  actor: Actor,
  affiliationId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<OperatorAffiliationDto> {
  await requireOperator(db, actor)
  const input = parseInput(revokeSchema, rawInput)
  if (!isUuid(affiliationId)) throw notFound()
  const id = affiliationId.toLowerCase()
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, id)).limit(1).for('update')
    if (!row) throw notFound()
    if (row.status !== 'active' && row.status !== 'pending') return
    await tx.update(institutionAffiliations).set(closedFields('revoked', now, 'operator')).where(eq(institutionAffiliations.id, row.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'affiliation.revoke',
      targetType: 'affiliation',
      targetId: row.id,
      metadata: { schoolId: row.schoolId, wasActive: row.status === 'active', reason: input.reason },
    })
  })
  const [r] = await loadRows(db, and(eq(institutionAffiliations.id, id)))
  return toOperatorDto(r!)
}

// ── 다른 모듈이 쓰는 읽기 ───────────────────────────────────────────────

/** 이 사용자의 active 소속이 가리키는 정본 학교 id들(과목 허브 작성 자격). */
export async function activeAffiliationSchoolIds(db: DbExecutor, userId: string): Promise<string[]> {
  const rows = await db
    .select({ schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(and(eq(institutionAffiliations.userId, userId), eq(institutionAffiliations.status, 'active')))
  return [...new Set(rows.map((r) => r.schoolId))]
}

/** 공개 프로필 배지: 본인이 켰을 때(showBadge)만, active 소속의 학교 이름 + 졸업생 여부. 학과·도메인은 넣지 않습니다. */
export async function publicAffiliationBadges(db: DbExecutor, userId: string, showBadge: boolean): Promise<PublicAffiliationBadgeDto[]> {
  if (!showBadge) return []
  const rows = await loadRows(db, and(eq(institutionAffiliations.userId, userId), eq(institutionAffiliations.status, 'active')))
  const seen = new Set<string>()
  const badges: PublicAffiliationBadgeDto[] = []
  for (const r of [...rows].reverse()) {
    if (seen.has(r.schoolId)) continue
    seen.add(r.schoolId)
    badges.push({ label: affiliationBadgeLabel(r.schoolName, r.row.standing), alumni: r.row.standing === 'alumni' })
  }
  return badges
}
