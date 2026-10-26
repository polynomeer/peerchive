/**
 * 학교 메일 도메인 관리(C-01, ADR 0018). 운영자만 등록·삭제합니다(API, 감사 기록). CLI `pnpm --filter @peerchive/db school-email-domain`도
 * 같은 규칙으로 씁니다.
 *
 * - 도메인은 @peerchive/domain `checkSchoolDomain`으로 정규화·검사합니다(TLD 하나·공용 접미사·웹메일 거부).
 * - 한 도메인은 한 학교: 다른 학교에 같은 도메인이 있으면 409 `domain_taken`, 다른 학교 도메인의 상위·하위 도메인이면 409 `domain_overlaps`.
 * - 병합된 학교 id로 부르면 정본 학교에 붙입니다. 학교 병합 때 도메인도 정본으로 옮깁니다(catalog/merge.ts).
 * - 도메인을 지워도 이미 인증된 소속은 그대로 active입니다(졸업 뒤 메일이 없어져도 이력을 유지하는 것과 같은 판단). 필요하면 운영자가 소속을 취소합니다.
 */
import { z } from 'zod'
import { checkSchoolDomain, findMatchingSchoolDomain, schoolDomainMatches } from '@peerchive/domain'
import { and, asc, eq, or, schoolEmailDomains, schools, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { loadCanonicalSchool } from '../catalog/catalog'
import { requireOperator } from '../catalog/operators'
import { type Actor, conflict, invalid, notFound, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import type { SchoolEmailDomainDto } from '../../../shared/types/api'

type DomainRow = typeof schoolEmailDomains.$inferSelect

const toDto = (row: DomainRow): SchoolEmailDomainDto => ({
  id: row.id,
  schoolId: row.schoolId,
  domain: row.domain,
  createdAt: row.createdAt.toISOString(),
})

const addSchema = z.object({ domain: z.string({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }).max(253, { error: 'too_long' }) })

/** 정본 학교와 그 학교로 병합된 학교 id들의 도메인(병합 때 옮기지만, 옮기기 전 행도 정본으로 봄). */
export async function domainsOfSchool(db: DbExecutor, canonicalSchoolId: string): Promise<DomainRow[]> {
  return db
    .select({ id: schoolEmailDomains.id, schoolId: schoolEmailDomains.schoolId, domain: schoolEmailDomains.domain, addedBy: schoolEmailDomains.addedBy, createdAt: schoolEmailDomains.createdAt })
    .from(schoolEmailDomains)
    .innerJoin(schools, eq(schools.id, schoolEmailDomains.schoolId))
    .where(or(eq(schools.id, canonicalSchoolId), eq(schools.mergedInto, canonicalSchoolId)))
    .orderBy(asc(schoolEmailDomains.domain))
}

/** 메일 도메인이 그 학교(정본)의 등록 도메인과 맞는지. 맞는 도메인 행 또는 null. */
export async function matchSchoolDomain(db: DbExecutor, canonicalSchoolId: string, mailDomain: string): Promise<DomainRow | null> {
  return findMatchingSchoolDomain(mailDomain, await domainsOfSchool(db, canonicalSchoolId))
}

/** GET /operator/schools/:id/email-domains — 운영자만(403). 없는 학교 404. */
export async function listSchoolEmailDomains(db: DbExecutor, actor: Actor, schoolId: unknown): Promise<SchoolEmailDomainDto[]> {
  await requireOperator(db, actor)
  const school = await loadCanonicalSchool(db, schoolId)
  return (await domainsOfSchool(db, school.id)).map(toDto)
}

/**
 * POST /operator/schools/:id/email-domains {domain} — 운영자만. 201 + 도메인(이미 그 학교에 있으면 200 `created: false`).
 * 422 `domain: invalid|shared_suffix|webmail`, 409 `domain_taken`·`domain_overlaps`.
 */
export async function addSchoolEmailDomain(
  db: DbExecutor,
  actor: Actor,
  schoolId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<{ created: boolean; domain: SchoolEmailDomainDto }> {
  await requireOperator(db, actor)
  const school = await loadCanonicalSchool(db, schoolId)
  const input = parseInput(addSchema, rawInput)
  const checked = checkSchoolDomain(input.domain)
  if (!checked.ok) throw invalid({ domain: checked.reason })
  const domain = checked.domain
  try {
    return await db.transaction(async (tx) => {
      // 도메인 등록을 직렬화해 겹침 확인과 insert 사이의 경합을 막습니다.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('school-email-domains'))`)
      const all = await tx
        .select({ id: schoolEmailDomains.id, schoolId: schoolEmailDomains.schoolId, domain: schoolEmailDomains.domain, addedBy: schoolEmailDomains.addedBy, createdAt: schoolEmailDomains.createdAt, mergedInto: schools.mergedInto })
        .from(schoolEmailDomains)
        .innerJoin(schools, eq(schools.id, schoolEmailDomains.schoolId))
      const ownerOf = (row: { schoolId: string; mergedInto: string | null }) => row.mergedInto ?? row.schoolId
      const same = all.find((r) => r.domain === domain)
      if (same) {
        if (ownerOf(same) === school.id) return { created: false, domain: toDto(same) }
        throw conflict('domain_taken')
      }
      if (all.some((r) => ownerOf(r) !== school.id && (schoolDomainMatches(domain, r.domain) || schoolDomainMatches(r.domain, domain)))) {
        throw conflict('domain_overlaps')
      }
      const [row] = await tx.insert(schoolEmailDomains).values({ schoolId: school.id, domain, addedBy: actor.userId, createdAt: now }).returning()
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'school_email_domain.add',
        targetType: 'school',
        targetId: school.id,
        metadata: { domain, domainId: row!.id },
      })
      return { created: true, domain: toDto(row!) }
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('domain_taken')
    throw error
  }
}

/** DELETE /operator/schools/:id/email-domains/:domainId — 운영자만. 200. 그 학교(정본)의 도메인이 아니면 404. 인증된 소속은 그대로. */
export async function removeSchoolEmailDomain(
  db: DbExecutor,
  actor: Actor,
  schoolId: unknown,
  domainId: unknown,
): Promise<{ removed: true; domain: SchoolEmailDomainDto }> {
  await requireOperator(db, actor)
  const school = await loadCanonicalSchool(db, schoolId)
  if (!isUuid(domainId)) throw notFound()
  return db.transaction(async (tx) => {
    const row = (await domainsOfSchool(tx, school.id)).find((r) => r.id === domainId.toLowerCase())
    if (!row) throw notFound()
    await tx.delete(schoolEmailDomains).where(and(eq(schoolEmailDomains.id, row.id)))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'school_email_domain.remove',
      targetType: 'school',
      targetId: school.id,
      metadata: { domain: row.domain, domainId: row.id },
    })
    return { removed: true as const, domain: toDto(row) }
  })
}
