/**
 * 기관 운영진(I-02, PROOFU_EVOLUTION_PLAN §8.9.11, SYSTEM_DESIGN §6.7.2 InstitutionAdmin·§8.4, DELIVERY_PLAN §4.3 I-02·§5.3 Z, ADR 0044).
 *
 * 모든 함수는 P2 기능 플래그 `institutions`가 꺼져 있으면 404입니다(`requireFeature`).
 *
 * - 지정·해제는 운영자만(`POST/GET /operator/institutions/:id/staff`, `DELETE /operator/institutions/:id/staff/:userId`). 대학이 아닌 기관만
 *   (대학은 422 `institutionId: not_supported`). 감사 `institution_staff.grant`·`.revoke`는 id만(지정 행·기관·대상 사용자 id).
 * - 운영진 권한(이 파일 밖에서 판정): 자기 기관의 기관 페이지·기수 방에서 모더레이터 범위(@peerchive/domain isInstitutionStaffFor),
 *   자기 기관 초대 코드 발급·목록·철회(institutions.ts의 staff 함수), 기관 집계(임계값 가림, community/institution-pages.ts).
 * - **없는 것**: 작성자 확인(운영자만, ADR 0023), 수료증 확인(운영자만, ADR 0037), 기관 단위 사용자 조회(소속 사용자 목록·프로필·과제 공간·
 *   팔로우·내보내기). 이 모듈의 응답에는 운영진 본인의 기관 목록 말고 사람 목록이 없습니다(운영자용 운영진 목록만 사용자 id·계정 이름).
 */
import { z } from 'zod'
import { isNonUniversityKind } from '@peerchive/domain'
import { and, asc, eq, inArray, institutionStaff, isNull, schools, sql, users, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { loadCanonicalSchool, type SchoolRow } from '../catalog/catalog'
import { isOperator, requireOperator } from '../catalog/operators'
import { type Actor, conflict, forbidden, invalid, notFound, sqlState } from '../errors'
import { requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import type { InstitutionDto, InstitutionStaffDto } from '../../../shared/types/api'

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const toInstitutionDto = (row: Pick<SchoolRow, 'id' | 'name' | 'kind'>): InstitutionDto => ({ id: row.id, name: row.name, kind: row.kind })

/**
 * 이 사람이 지금 운영진인 정본 기관 id(해제되지 않은 행 + active 계정). 플래그를 보지 않습니다(호출자가 봄 — 커뮤니티 viewer는 켜져 있을 때만 부름).
 */
export async function staffInstitutionIds(db: DbExecutor, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
    .from(institutionStaff)
    .innerJoin(schools, eq(schools.id, institutionStaff.schoolId))
    .innerJoin(users, eq(users.id, institutionStaff.userId))
    .where(and(eq(institutionStaff.userId, userId), isNull(institutionStaff.revokedAt), eq(users.status, 'active')))
  return rows.map((r) => r.schoolId)
}

export interface InstitutionManager {
  institution: SchoolRow
  /** 운영자로서 판정됐는지(아니면 그 기관의 운영진). 감사 `byStaff`에 씁니다. */
  operator: boolean
}

/**
 * 운영자 또는 그 기관의 active 운영진만(아니면 403 `institution_staff_only`). 없는 기관 404, 대학 422 `institutionId: not_supported`.
 * 플래그는 호출자가 먼저 봅니다.
 */
export async function requireInstitutionManager(db: DbExecutor, actor: Actor, institutionId: unknown): Promise<InstitutionManager> {
  const institution = await loadCanonicalSchool(db, institutionId)
  if (!isNonUniversityKind(institution.kind)) throw invalid({ institutionId: 'not_supported' })
  if (await isOperator(db, actor.userId)) return { institution, operator: true }
  if ((await staffInstitutionIds(db, actor.userId)).includes(institution.id)) return { institution, operator: false }
  throw forbidden('institution_staff_only')
}

/** 그 기관을 운영할 수 있는지(운영자 또는 그 기관 운영진). 존재를 숨겨야 하는 경로(코드 철회)에서 씁니다. */
export async function canManageInstitution(db: DbExecutor, actor: Actor, institutionId: string): Promise<boolean> {
  if (await isOperator(db, actor.userId)) return true
  return (await staffInstitutionIds(db, actor.userId)).includes(institutionId)
}

/** GET /me/institution-staff — 내가 운영진인 기관(이름·종류만). 운영진이 아니면 빈 목록. */
export async function listMyStaffInstitutions(db: DbExecutor, actor: Actor): Promise<InstitutionDto[]> {
  requireFeature('institutions')
  const ids = await staffInstitutionIds(db, actor.userId)
  if (ids.length === 0) return []
  const rows = await db.select({ id: schools.id, name: schools.name, kind: schools.kind }).from(schools).where(inArray(schools.id, ids)).orderBy(asc(schools.name))
  return rows.map(toInstitutionDto)
}

// ── 운영자: 지정·해제 ────────────────────────────────────────────────────

const grantSchema = z.object({ userId: z.uuid({ error: requiredOr('invalid') }).transform((v) => v.toLowerCase()) })

/** GET /operator/institutions/:id/staff — 운영자만. 지금 운영진(사용자 id·계정 이름·지정 시각). */
export async function listInstitutionStaff(db: DbExecutor, actor: Actor, institutionId: unknown): Promise<InstitutionStaffDto[]> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const institution = await loadCanonicalSchool(db, institutionId)
  const rows = await db
    .select({ id: institutionStaff.id, userId: institutionStaff.userId, displayName: users.displayName, grantedAt: institutionStaff.grantedAt })
    .from(institutionStaff)
    .innerJoin(users, eq(users.id, institutionStaff.userId))
    .where(and(eq(institutionStaff.schoolId, institution.id), isNull(institutionStaff.revokedAt)))
    .orderBy(asc(institutionStaff.grantedAt), asc(institutionStaff.id))
  return rows.map((r) => ({ id: r.id, userId: r.userId, displayName: r.displayName, grantedAt: r.grantedAt.toISOString() }))
}

/**
 * POST /operator/institutions/:id/staff {userId} — 운영자만. 201 + 운영진 목록. 대학 422 `institutionId: not_supported`,
 * 없는·active가 아닌 사용자 422 `userId: not_found|inactive`, 이미 운영진 409 `already_staff`. 감사 id만.
 */
export async function grantInstitutionStaff(db: DbExecutor, actor: Actor, institutionId: unknown, rawInput: unknown, now = new Date()): Promise<InstitutionStaffDto[]> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const { userId } = parseInput(grantSchema, rawInput)
  const institution = await loadCanonicalSchool(db, institutionId)
  if (!isNonUniversityKind(institution.kind)) throw invalid({ institutionId: 'not_supported' })
  const [target] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1)
  if (!target) throw invalid({ userId: 'not_found' })
  if (target.status !== 'active') throw invalid({ userId: 'inactive' })
  await db.transaction(async (tx) => {
    let row
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(institutionStaff)
          .values({ schoolId: institution.id, userId, grantedBy: actor.userId, grantedAt: now })
          .returning({ id: institutionStaff.id })
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('already_staff')
      throw error
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'institution_staff.grant',
      targetType: 'institution_staff',
      targetId: row.id,
      metadata: { schoolId: institution.id, userId },
    })
  })
  return listInstitutionStaff(db, actor, institution.id)
}

/** DELETE /operator/institutions/:id/staff/:userId — 운영자만. 해제(revoked_at·revoked_by, 행은 남김). 운영진이 아니면 404. 감사 id만. */
export async function revokeInstitutionStaff(db: DbExecutor, actor: Actor, institutionId: unknown, userId: unknown, now = new Date()): Promise<InstitutionStaffDto[]> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const institution = await loadCanonicalSchool(db, institutionId)
  if (!isUuid(userId)) throw notFound()
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: institutionStaff.id, userId: institutionStaff.userId })
      .from(institutionStaff)
      .where(and(eq(institutionStaff.schoolId, institution.id), eq(institutionStaff.userId, userId.toLowerCase()), isNull(institutionStaff.revokedAt)))
      .limit(1)
      .for('update')
    if (!row) throw notFound()
    await tx.update(institutionStaff).set({ revokedAt: now, revokedBy: actor.userId }).where(eq(institutionStaff.id, row.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'institution_staff.revoke',
      targetType: 'institution_staff',
      targetId: row.id,
      metadata: { schoolId: institution.id, userId: row.userId },
    })
  })
  return listInstitutionStaff(db, actor, institution.id)
}
