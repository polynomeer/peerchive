/**
 * C-01 학교 메일 인증·학과 자기 신고 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * I-01(ADR 0037): 같은 테스트를 P2 기관 플래그를 끈 상태와 켠 상태에서 한 번씩 돌립니다(학교 메일 인증 회귀 0건).
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교(무작위 이름·도메인)와 사용자만 봅니다. 메일은 메모리 transport로 받습니다.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  affiliationCodes,
  analyticsEvents,
  and,
  auditEvents,
  eq,
  institutionAffiliations,
  operators,
  profiles,
  schoolEmailDomains,
  type DbExecutor,
} from '@peerchive/db'
import {
  hashSchoolEmail,
  listAffiliationsForOperator,
  listMyAffiliations,
  removeAffiliation,
  requestAffiliation,
  revokeAffiliationByOperator,
  updateAffiliation,
  verifyAffiliation,
} from '../server/modules/affiliation/affiliations'
import { affiliationPepper, setAffiliationEnvForTesting } from '../server/modules/affiliation/config'
import { addSchoolEmailDomain, listSchoolEmailDomains, removeSchoolEmailDomain } from '../server/modules/affiliation/domains'
import { analyticsPepper } from '../server/modules/analytics/analytics'
import { createCourse, createSchool } from '../server/modules/catalog/catalog'
import { mergeSchool } from '../server/modules/catalog/merge'
import { createSeniorNote, getHubWriteEligibility, publishSeniorNote } from '../server/modules/course-hub/senior-notes'
import { createMemoryTransport, type MailTransport } from '../server/modules/identity/mail'
import { getMe, upsertProfile } from '../server/modules/identity/profiles'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { hashSubject } from '@peerchive/db'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const NOTE_INPUT = {
  displayMode: 'name',
  answers: { firstWeek: '명세를 끝까지 읽기', timeSink: '테스트 환경 맞추기' },
  noAnswersConfirmed: true,
}

interface Fixture {
  operator: { userId: string }
  schoolId: string
  schoolName: string
  domain: string
  courseId: string
}

/** 운영자 + 학교(무작위 도메인 등록) + 과목. */
async function schoolFixture(db: DbExecutor, operator?: { userId: string }): Promise<Fixture> {
  const op = operator ?? { userId: (await createUser(db)).id }
  if (!operator) await db.insert(operators).values({ userId: op.userId })
  const t = token()
  const schoolName = `인증대${t}학교`
  const school = await createSchool(db, op, { name: schoolName, confirmNew: true }, T0)
  const domain = `u${t}.ac.kr`
  await addSchoolEmailDomain(db, op, school.id, { domain }, T0)
  const course = await createCourse(db, op, school.id, { title: `자료구조${t}`, confirmNew: true }, T0)
  return { operator: op, schoolId: school.id, schoolName, domain, courseId: course.id }
}

interface Requested {
  id: string
  code: string | null
  mail: MailTransport & { messages: { to: string; text: string }[] }
}

async function request(
  db: DbExecutor,
  userId: string,
  input: Record<string, unknown>,
  now = T0,
  ip = crypto.randomUUID(),
): Promise<Requested & { dto: Awaited<ReturnType<typeof requestAffiliation>> }> {
  const mail = createMemoryTransport()
  const dto = await requestAffiliation(db, { userId }, { standing: 'student', ...input }, { ip, mail, now })
  const code = mail.messages.at(-1)?.text.match(/인증 코드: (\d{6})/)?.[1] ?? null
  return { id: dto.id, code, mail, dto }
}

const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000')

for (const p2 of ['off', 'on'] as const) describe.skipIf(!databaseUrl)(`school affiliation (PostgreSQL, P2 institutions ${p2})`, () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2_INSTITUTIONS: p2 }))
  afterEach(() => {
    setAffiliationEnvForTesting(null)
    setFeatureEnvForTesting(null)
  })

  it('lets only operators manage school email domains (normalized, no shared suffixes, one school per domain, audited)', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const other = await schoolFixture(tx, f.operator)
      const student = await createUser(tx)
      await expectServiceError(addSchoolEmailDomain(tx, { userId: student.id }, f.schoolId, { domain: 'x.ac.kr' }), 'FORBIDDEN', 'operator_only')
      await expectServiceError(listSchoolEmailDomains(tx, { userId: student.id }, f.schoolId), 'FORBIDDEN', 'operator_only')

      const t = token()
      const added = await addSchoolEmailDomain(tx, f.operator, f.schoolId, { domain: ` Mail${t}.AC.KR. ` }, T0)
      expect(added).toMatchObject({ created: true, domain: { schoolId: f.schoolId, domain: `mail${t}.ac.kr` } })
      expect(await addSchoolEmailDomain(tx, f.operator, f.schoolId, { domain: `mail${t}.ac.kr` }, T0)).toMatchObject({ created: false })
      for (const [domain, reason] of [['ac.kr', 'shared_suffix'], ['gmail.com', 'webmail'], ['kr', 'invalid'], ['*.ac.kr', 'invalid']] as const) {
        const e = await expectServiceError(addSchoolEmailDomain(tx, f.operator, f.schoolId, { domain }), 'VALIDATION')
        expect(e.fields).toEqual({ domain: reason })
      }
      await expectServiceError(addSchoolEmailDomain(tx, f.operator, other.schoolId, { domain: f.domain }), 'CONFLICT', 'domain_taken')
      await expectServiceError(addSchoolEmailDomain(tx, f.operator, other.schoolId, { domain: `stu.${f.domain}` }), 'CONFLICT', 'domain_overlaps')
      await expectServiceError(addSchoolEmailDomain(tx, f.operator, crypto.randomUUID(), { domain: `n${t}.ac.kr` }), 'NOT_FOUND')

      const listed = await listSchoolEmailDomains(tx, f.operator, f.schoolId)
      expect(listed.map((d) => d.domain).sort()).toEqual([f.domain, `mail${t}.ac.kr`].sort())
      await expectServiceError(removeSchoolEmailDomain(tx, f.operator, other.schoolId, added.domain.id), 'NOT_FOUND')
      await removeSchoolEmailDomain(tx, f.operator, f.schoolId, added.domain.id)
      expect((await listSchoolEmailDomains(tx, f.operator, f.schoolId)).map((d) => d.domain)).toEqual([f.domain])
      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, f.schoolId)))
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['school_email_domain.add', 'school_email_domain.remove']))
    })
  })

  it('request → code mail → verify: stores only an HMAC + domain, never the address; audits and emits a props-only event', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const user = await createUser(tx)
      const local = `kim.${token()}`
      const address = `${local}+peer@stu.${f.domain}`
      const r = await request(tx, user.id, { schoolId: f.schoolId, email: `  ${address.toUpperCase()} `, departmentLabel: '  컴퓨터공학과 ' })
      expect(r.mail.messages).toHaveLength(1)
      expect(r.mail.messages[0]!.to).toBe(address)
      expect(r.mail.messages[0]!.text).toContain('10분')
      expect(r.mail.messages[0]!.text).toContain('요청하지 않았다면')
      expect(r.code).toMatch(/^\d{6}$/)
      expect(r.dto).toMatchObject({
        status: 'pending',
        standing: 'student',
        departmentLabel: '컴퓨터공학과',
        emailDomain: `stu.${f.domain}`,
        school: { id: f.schoolId, name: f.schoolName },
        code: { attemptsLeft: 5, expiresAt: at(10).toISOString() },
      })
      expect(JSON.stringify(r.dto)).not.toContain(local)

      // DB에는 주소가 없고 정규 주소(+태그 제거)의 HMAC만 있습니다. 코드도 원문이 없습니다.
      const [row] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, r.id))
      const [codeRow] = await tx.select().from(affiliationCodes).where(eq(affiliationCodes.affiliationId, r.id))
      expect(JSON.stringify({ row, codeRow })).not.toContain(local)
      expect(JSON.stringify(codeRow)).not.toContain(r.code!)
      expect(row!.emailHash).toBe(hashSchoolEmail(affiliationPepper(), `${local}@stu.${f.domain}`))

      const verified = await verifyAffiliation(tx, { userId: user.id }, r.id, { code: ` ${r.code} ` }, at(3))
      expect(verified).toMatchObject({ status: 'active', verifiedAt: at(3).toISOString(), code: null })
      // 같은 요청을 다시 보내도 200(이미 active).
      expect(await verifyAffiliation(tx, { userId: user.id }, r.id, { code: r.code }, at(4))).toMatchObject({ status: 'active' })
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'affiliation.verify'), eq(auditEvents.targetId, r.id)))
      expect(JSON.stringify(audit!.metadata)).not.toContain(local)
      expect(audit!.metadata).not.toHaveProperty('departmentLabel')
      const events = await tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(analyticsPepper()!, user.id)))
      expect(events.map((e) => [e.name, e.props])).toEqual([['affiliation_verified', { method: 'email', standing: 'student' }]])

      const list = await listMyAffiliations(tx, { userId: user.id })
      expect(list).toMatchObject({ showBadge: false, hubRequiresAffiliation: true, items: [{ id: r.id, status: 'active' }] })
      // 같은 학교에 다시 요청하면 409(이미 인증됨). 다른 사람의 요청과 무관한 내 상태라 알려 줘도 됩니다.
      await expectServiceError(request(tx, user.id, { schoolId: f.schoolId, email: `other.${token()}@${f.domain}` }), 'CONFLICT', 'already_verified')
      // 다른 사람이 내 소속을 확인할 수 없음.
      const stranger = await createUser(tx)
      await expectServiceError(verifyAffiliation(tx, { userId: stranger.id }, r.id, { code: r.code }), 'NOT_FOUND')
    })
  })

  it('counts wrong codes and locks after five (410), and expires after ten minutes (410)', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const user = await createUser(tx)
      const actor = { userId: user.id }
      const r = await request(tx, user.id, { schoolId: f.schoolId, email: `lee.${token()}@${f.domain}` })
      const bad = wrongCode(r.code!)
      const malformed = await expectServiceError(verifyAffiliation(tx, actor, r.id, { code: '12ab' }, at(1)), 'VALIDATION')
      expect(malformed.fields).toEqual({ code: 'invalid_format' })
      for (const left of [4, 3, 2, 1]) {
        const e = await expectServiceError(verifyAffiliation(tx, actor, r.id, { code: bad }, at(1)), 'VALIDATION', 'code_mismatch')
        expect(e.details).toEqual({ attemptsLeft: left })
        expect((await listMyAffiliations(tx, actor)).items[0]!.code?.attemptsLeft).toBe(left)
      }
      await expectServiceError(verifyAffiliation(tx, actor, r.id, { code: bad }, at(1)), 'GONE', 'attempts_exceeded')
      // 잠긴 뒤에는 맞는 코드도 소용없고, 요청은 메일 해시 없이 expired로 끝납니다.
      await expectServiceError(verifyAffiliation(tx, actor, r.id, { code: r.code }, at(2)), 'GONE', 'code_unavailable')
      const [locked] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, r.id))
      expect(locked).toMatchObject({ status: 'expired', emailHash: null })
      expect((await listMyAffiliations(tx, actor)).items).toEqual([])

      // 새로 요청하면 새 코드. 10분이 지나면 맞는 코드도 410.
      const again = await request(tx, user.id, { schoolId: f.schoolId, email: `lee.${token()}@${f.domain}` }, at(5))
      await expectServiceError(verifyAffiliation(tx, actor, again.id, { code: again.code }, at(15)), 'GONE', 'code_expired')
      const [expired] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, again.id))
      expect(expired).toMatchObject({ status: 'expired', emailHash: null })

      // 같은 학교에 다시 요청하면 이전 pending은 대체됩니다(이전 코드 무효).
      const first = await request(tx, user.id, { schoolId: f.schoolId, email: `lee.${token()}@${f.domain}` }, at(20))
      const second = await request(tx, user.id, { schoolId: f.schoolId, email: `lee.${token()}@${f.domain}` }, at(21))
      await expectServiceError(verifyAffiliation(tx, actor, first.id, { code: first.code }, at(22)), 'GONE', 'code_unavailable')
      expect(await verifyAffiliation(tx, actor, second.id, { code: second.code }, at(22))).toMatchObject({ status: 'active' })
    })
  })

  it('is enumeration-safe at request time (same 202 for an address used by another account) and says email_in_use only after the code proves ownership', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const a = await createUser(tx)
      const b = await createUser(tx)
      const address = `park.${token()}@${f.domain}`
      const ra = await request(tx, a.id, { schoolId: f.schoolId, email: address })
      await verifyAffiliation(tx, { userId: a.id }, ra.id, { code: ra.code }, at(1))

      // b가 같은 주소(+태그 별칭)로 요청: 응답 모양·발송은 처음 쓰는 주소와 같습니다.
      const fresh = await request(tx, b.id, { schoolId: f.schoolId, email: `fresh.${token()}@${f.domain}` }, at(2))
      const rb = await request(tx, b.id, { schoolId: f.schoolId, email: address.replace('@', '+alias@') }, at(2))
      expect(Object.keys(rb.dto).sort()).toEqual(Object.keys(fresh.dto).sort())
      expect(rb.dto).toMatchObject({ status: 'pending', code: { attemptsLeft: 5 } })
      expect(rb.mail.messages).toHaveLength(1)
      // 코드로 주소 소유를 증명한 뒤에만 409.
      await expectServiceError(verifyAffiliation(tx, { userId: b.id }, rb.id, { code: rb.code }, at(3)), 'CONFLICT', 'email_in_use')
      const [rowB] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, rb.id))
      expect(rowB).toMatchObject({ status: 'expired', emailHash: null })

      // a가 해제하면 그 주소를 다른 계정이 인증할 수 있습니다(해제 행에는 메일 해시가 남지 않음).
      const removed = await removeAffiliation(tx, { userId: a.id }, ra.id, at(4))
      expect(removed).toMatchObject({ status: 'revoked', revokedReason: 'user_removed', verifiedAt: at(1).toISOString() })
      const [rowA] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, ra.id))
      expect(rowA!.emailHash).toBeNull()
      const rb2 = await request(tx, b.id, { schoolId: f.schoolId, email: address }, at(5))
      expect(await verifyAffiliation(tx, { userId: b.id }, rb2.id, { code: rb2.code }, at(6))).toMatchObject({ status: 'active' })
      // 해제 이력은 목록에 남습니다.
      expect((await listMyAffiliations(tx, { userId: a.id })).items.map((i) => i.status)).toEqual(['revoked'])
    })
  })

  it('applies per-address (silent), per-user and per-IP rate limits', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const users = await Promise.all([1, 2, 3, 4].map(() => createUser(tx)))
      const address = `choi.${token()}@${f.domain}`
      // 같은 주소: 세 번까지 발송, 네 번째는 같은 응답에 발송만 없음.
      const sent: number[] = []
      for (const u of users) sent.push((await request(tx, u.id, { schoolId: f.schoolId, email: address }, at(1))).mail.messages.length)
      expect(sent).toEqual([1, 1, 1, 0])

      const heavy = await createUser(tx)
      for (let i = 0; i < 5; i++) await request(tx, heavy.id, { schoolId: f.schoolId, email: `h${i}.${token()}@${f.domain}` }, at(2))
      await expectServiceError(request(tx, heavy.id, { schoolId: f.schoolId, email: `h.${token()}@${f.domain}` }, at(2)), 'RATE_LIMITED')
      // 도메인 거부도 사용자 한도에 들어갑니다(도메인 추측 제한).
      const prober = await createUser(tx)
      for (let i = 0; i < 5; i++) {
        await expectServiceError(request(tx, prober.id, { schoolId: f.schoolId, email: `x@guess${i}.ac.kr` }, at(3)), 'VALIDATION', 'domain_not_allowed')
      }
      await expectServiceError(request(tx, prober.id, { schoolId: f.schoolId, email: `x@${f.domain}` }, at(3)), 'RATE_LIMITED')

      const ip = crypto.randomUUID()
      const many = await Promise.all(Array.from({ length: 7 }, () => createUser(tx)))
      let limited = 0
      for (const u of many) {
        for (let i = 0; i < 5; i++) {
          const result = await request(tx, u.id, { schoolId: f.schoolId, email: `ip${i}.${token()}@${f.domain}` }, at(4), ip).catch((e: unknown) => e)
          if (result instanceof Error && (result as { code?: string }).code === 'RATE_LIMITED') limited++
        }
      }
      expect(limited).toBe(35 - 30)
    })
  })

  it("rejects other schools' domains without hinting them, accepts subdomains, refuses lookalikes, and validates input", async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const other = await schoolFixture(tx, f.operator)
      const user = await createUser(tx)
      const e = await expectServiceError(request(tx, user.id, { schoolId: f.schoolId, email: `kim@${other.domain}` }), 'VALIDATION', 'domain_not_allowed')
      expect(e.fields).toEqual({ email: 'domain_not_allowed' })
      expect(JSON.stringify(e)).not.toContain(f.domain)
      for (const email of [`kim@evil${f.domain}`, `kim@${f.domain}.evil.com`, `kim@${f.domain.replace('u', 'у')}`]) {
        await expectServiceError(request(tx, user.id, { schoolId: f.schoolId, email }), 'VALIDATION', 'domain_not_allowed')
      }
      const bad = await expectServiceError(request(tx, user.id, { schoolId: f.schoolId, email: 'not-an-email' }), 'VALIDATION')
      expect(bad.fields).toEqual({ email: 'invalid_format' })
      const dept = await expectServiceError(request(tx, user.id, { schoolId: f.schoolId, email: `a@${f.domain}`, departmentLabel: '가'.repeat(41) }), 'VALIDATION')
      expect(dept.fields).toEqual({ departmentLabel: 'too_long' })
      const standing = await expectServiceError(request(tx, user.id, { schoolId: f.schoolId, email: `a@${f.domain}`, standing: 'professor' }), 'VALIDATION')
      expect(standing.fields).toEqual({ standing: 'invalid' })
      await expectServiceError(request(tx, user.id, { schoolId: crypto.randomUUID(), email: `a@${f.domain}` }), 'NOT_FOUND')
      const sub = await request(tx, user.id, { schoolId: f.schoolId, email: `a@grad.stu.${f.domain}` })
      expect(sub.dto.emailDomain).toBe(`grad.stu.${f.domain}`)
    })
  })

  it('lets a student switch to alumni (history kept) but not back, and edits the self-reported department', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const user = await createUser(tx)
      const actor = { userId: user.id }
      const r = await request(tx, user.id, { schoolId: f.schoolId, email: `jung.${token()}@${f.domain}` })
      await verifyAffiliation(tx, actor, r.id, { code: r.code }, at(1))
      const alumni = await updateAffiliation(tx, actor, r.id, { standing: 'alumni', departmentLabel: '소프트웨어학과' }, at(2))
      expect(alumni).toMatchObject({ status: 'active', standing: 'alumni', departmentLabel: '소프트웨어학과', verifiedAt: at(1).toISOString() })
      const back = await expectServiceError(updateAffiliation(tx, actor, r.id, { standing: 'student' }, at(3)), 'VALIDATION')
      expect(back.fields).toEqual({ standing: 'not_allowed' })
      expect(await updateAffiliation(tx, actor, r.id, { departmentLabel: null }, at(3))).toMatchObject({ departmentLabel: null })
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'affiliation.update'), eq(auditEvents.targetId, r.id)))
      expect(JSON.stringify(audit!.metadata)).not.toContain('소프트웨어학과')
      await expectServiceError(updateAffiliation(tx, { userId: (await createUser(tx)).id }, r.id, { standing: 'alumni' }), 'NOT_FOUND')
      await removeAffiliation(tx, actor, r.id, at(4))
      await expectServiceError(updateAffiliation(tx, actor, r.id, { departmentLabel: 'x' }), 'CONFLICT', 'not_editable')
    })
  })

  it('requires an active affiliation with the course school to write to the course hub (create and publish), follows school merges, and honours the dev policy flag', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const other = await schoolFixture(tx, f.operator)
      const author = await createUser(tx)
      const actor = { userId: author.id }

      const blocked = await expectServiceError(createSeniorNote(tx, actor, f.courseId, NOTE_INPUT, at(1)), 'FORBIDDEN', 'hub_write_not_allowed')
      expect(blocked.details).toEqual({ requirement: 'school_affiliation', schoolId: f.schoolId })
      expect(await getHubWriteEligibility(tx, actor, f.courseId)).toEqual({
        courseId: f.courseId,
        allowed: false,
        requirement: 'school_affiliation',
        school: { id: f.schoolId, name: f.schoolName },
      })
      await expectServiceError(getHubWriteEligibility(tx, actor, crypto.randomUUID()), 'NOT_FOUND')

      // 다른 학교 인증으로는 쓸 수 없음.
      const ro = await request(tx, author.id, { schoolId: other.schoolId, email: `x.${token()}@${other.domain}` })
      await verifyAffiliation(tx, actor, ro.id, { code: ro.code }, at(1))
      await expectServiceError(createSeniorNote(tx, actor, f.courseId, NOTE_INPUT, at(2)), 'FORBIDDEN', 'hub_write_not_allowed')
      // pending은 아직 아님.
      const r = await request(tx, author.id, { schoolId: f.schoolId, email: `x.${token()}@${f.domain}` }, at(2))
      await expectServiceError(createSeniorNote(tx, actor, f.courseId, NOTE_INPUT, at(2)), 'FORBIDDEN', 'hub_write_not_allowed')
      await verifyAffiliation(tx, actor, r.id, { code: r.code }, at(3))
      expect(await getHubWriteEligibility(tx, actor, f.courseId)).toMatchObject({ allowed: true, requirement: null })
      const draft = await createSeniorNote(tx, actor, f.courseId, NOTE_INPUT, at(4))
      expect(draft.status).toBe('draft')
      // 졸업생으로 바꿔도 이력이 유지되어 계속 쓸 수 있음.
      await updateAffiliation(tx, actor, r.id, { standing: 'alumni' }, at(5))
      const published = await publishSeniorNote(tx, actor, draft.id, { expectedVersion: 1 }, at(6))
      expect(published.status).toBe('published')

      // 운영자가 취소하면 게시(재확인)도 막힘. 이미 게시된 노트는 그대로.
      const draft2 = await createSeniorNote(tx, actor, f.courseId, NOTE_INPUT, at(7))
      await expectServiceError(revokeAffiliationByOperator(tx, actor, r.id, { reason: 'x' }), 'FORBIDDEN', 'operator_only')
      const revoked = await revokeAffiliationByOperator(tx, f.operator, r.id, { reason: '사칭 신고 확인' }, at(8))
      expect(revoked).toMatchObject({ status: 'revoked', userId: author.id, emailDomain: f.domain, school: { id: f.schoolId } })
      expect(Object.keys(revoked).sort()).toEqual(['emailDomain', 'id', 'revokedAt', 'school', 'status', 'userId', 'verifiedAt'])
      await expectServiceError(publishSeniorNote(tx, actor, draft2.id, { expectedVersion: 1 }, at(9)), 'FORBIDDEN', 'hub_write_not_allowed')
      const [revokedRow] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, r.id))
      expect(revokedRow).toMatchObject({ status: 'revoked', revokedReason: 'operator', emailHash: null })
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'affiliation.revoke'), eq(auditEvents.targetId, r.id)))
      expect(audit!.metadata).toMatchObject({ reason: '사칭 신고 확인', wasActive: true })
      const opList = await listAffiliationsForOperator(tx, f.operator, { schoolId: f.schoolId })
      expect(opList.map((a) => [a.id, a.status])).toEqual([[r.id, 'revoked']])
      expect(JSON.stringify(opList)).not.toMatch(/standing|department/)

      // 학교 병합: 다른 학교(other) 인증은 정본(f)으로 따라가므로, other를 f로 병합하면 f 과목에 쓸 수 있습니다.
      await mergeSchool(tx, f.operator, other.schoolId, { into: f.schoolId }, at(10))
      expect(await createSeniorNote(tx, actor, other.courseId, NOTE_INPUT, at(11))).toMatchObject({ status: 'draft' })
      const [moved] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, ro.id))
      expect(moved).toMatchObject({ schoolId: f.schoolId, status: 'active' })
      const domains = await tx.select().from(schoolEmailDomains).where(eq(schoolEmailDomains.schoolId, f.schoolId))
      expect(domains.map((d) => d.domain).sort()).toEqual([f.domain, other.domain].sort())
      // 병합된 학교 id로 요청해도 정본 학교로 이어지고, 이미 인증된 정본이라 409.
      await expectServiceError(request(tx, author.id, { schoolId: other.schoolId, email: `y.${token()}@${other.domain}` }), 'CONFLICT', 'already_verified')

      // 개발용 정책 플래그(0)면 인증 없이도 씀. 정지 계정은 여전히 막힘.
      const noAffiliation = await createUser(tx)
      setAffiliationEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_HUB_REQUIRE_AFFILIATION: '0' })
      expect(await createSeniorNote(tx, { userId: noAffiliation.id }, f.courseId, NOTE_INPUT, at(12))).toMatchObject({ status: 'draft' })
      expect((await listMyAffiliations(tx, { userId: noAffiliation.id })).hubRequiresAffiliation).toBe(false)
      setAffiliationEnvForTesting(null)
      await expectServiceError(createSeniorNote(tx, { userId: noAffiliation.id }, f.courseId, NOTE_INPUT, at(13)), 'FORBIDDEN', 'hub_write_not_allowed')
    })
  })

  it('closes duplicate open affiliations when merging schools (one open row per user and school)', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const other = await schoolFixture(tx, f.operator)
      const u = await createUser(tx)
      const ra = await request(tx, u.id, { schoolId: f.schoolId, email: `a.${token()}@${f.domain}` })
      await verifyAffiliation(tx, { userId: u.id }, ra.id, { code: ra.code }, at(1))
      const rb = await request(tx, u.id, { schoolId: other.schoolId, email: `b.${token()}@${other.domain}` })
      await verifyAffiliation(tx, { userId: u.id }, rb.id, { code: rb.code }, at(1))
      await mergeSchool(tx, f.operator, other.schoolId, { into: f.schoolId }, at(2))
      const rows = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.userId, u.id))
      expect(rows.map((r) => [r.id, r.schoolId, r.status, r.revokedReason]).sort()).toEqual(
        [
          [ra.id, f.schoolId, 'active', null],
          [rb.id, f.schoolId, 'revoked', 'merged_duplicate'],
        ].sort(),
      )
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'school.merge'), eq(auditEvents.targetId, other.schoolId)))
      expect(audit!.metadata).toMatchObject({ affiliationsMoved: 1, affiliationsClosed: 1, emailDomainsMoved: 1 })
    })
  })

  it('never exposes email, domain or department publicly; shows the school badge only when opted in', async () => {
    await withRollback(async (tx) => {
      const f = await schoolFixture(tx)
      const user = await createUser(tx)
      const handle = `aff-${token()}`
      await upsertProfile(tx, { userId: user.id }, { handle, displayName: '공개 이름' })
      const local = `secret.${token()}`
      const r = await request(tx, user.id, { schoolId: f.schoolId, email: `${local}@${f.domain}`, departmentLabel: '비밀학과' })
      await verifyAffiliation(tx, { userId: user.id }, r.id, { code: r.code }, at(1))

      const hidden = await getPublicPortfolioProfile(tx, handle, at(2))
      expect(hidden.affiliationBadges).toEqual([])
      for (const s of [local, f.domain, '비밀학과', f.schoolName]) expect(JSON.stringify(hidden)).not.toContain(s)

      const me = await upsertProfile(tx, { userId: user.id }, { showAffiliationBadge: true })
      expect(me.profile?.showAffiliationBadge).toBe(true)
      const shown = await getPublicPortfolioProfile(tx, handle, at(3))
      expect(shown.affiliationBadges).toEqual([{ label: `${f.schoolName} 인증`, alumni: false }])
      await updateAffiliation(tx, { userId: user.id }, r.id, { standing: 'alumni' }, at(4))
      const alumni = await getPublicPortfolioProfile(tx, handle, at(5))
      expect(alumni.affiliationBadges).toEqual([{ label: `${f.schoolName} 인증 · 졸업생`, alumni: true }])
      for (const s of [local, f.domain, '비밀학과']) expect(JSON.stringify(alumni)).not.toContain(s)
      // 본인 정보(getMe)에도 학교 메일은 없습니다(로그인 메일만).
      expect(JSON.stringify(await getMe(tx, { userId: user.id }))).not.toContain(local)
      const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, user.id))
      expect(profile!.showAffiliationBadge).toBe(true)

      // 해제하면 배지도 사라짐.
      await removeAffiliation(tx, { userId: user.id }, r.id, at(6))
      expect((await getPublicPortfolioProfile(tx, handle, at(7))).affiliationBadges).toEqual([])
    })
  })
})
