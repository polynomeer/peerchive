/**
 * C-10 커뮤니티 운영 도구·계측 통합 테스트(DELIVERY_PLAN §4.1 C-10·§6.1·§7 GC, ADR 0027). 실제 PostgreSQL(rollback).
 * - 신고 처리 기한: 나이·우선순위·기한 넘김 필터·첫 조치 시각·상세 상태 확인의 개수
 * - 주간 운영 시간: 운영자만, 본인 것만, 입력 검사, 감사(id만)
 * - 커뮤니티 지표: 실제 서비스 흐름 + 이벤트 fixture(익명 = 사용자 키 없음), 5 미만 가림, 공간별 보기 기준, CSV(id·이름·글 없음)·rate limit
 * - 분석 emitter: 커뮤니티 행동마다 기대 이벤트, 익명 대상은 actor_hash null
 * 다른 데이터와 섞이지 않게 먼 미래(2093년) 시각을 쓰고, 개수는 이 테스트가 만든 것(또는 전후 차이)만 확인합니다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ANALYTICS_PROP_SPECS, isoWeekOf } from '@peerchive/domain'
import { analyticsEvents, auditEvents, communityPosts, communitySpaces, eq, hashSubject, operators, opsTimeEntries, reports, sql, type DbExecutor } from '@peerchive/db'
import { createFilesystemStorage } from '@peerchive/files'
import { analyticsPepper, setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { createSchool } from '../server/modules/catalog/catalog'
import { joinSpace } from '../server/modules/community/memberships'
import { issueSanction, lookupAuthor, setAutoHideThresholdsForTesting } from '../server/modules/community/moderation'
import {
  exportCommunityMetricsCsv,
  getCommunityMetrics,
  listMetricsSpaces,
  setSpaceBreakdownMinMembersForTesting,
  spaceBreakdownMinMembers,
} from '../server/modules/community/ops-metrics'
import { createComment, createPost, setReaction } from '../server/modules/community/posts'
import { createRoom } from '../server/modules/community/spaces'
import { assignReport, dismissReport, listReportGroups, resolveReport } from '../server/modules/moderation/operator'
import { createReport } from '../server/modules/moderation/reports'
import { setReportSlaTargetsForTesting } from '../server/modules/moderation/sla'
import { deepHealth } from '../server/modules/ops/health'
import { deleteMyOpsTime, listMyOpsTime, saveMyOpsTime } from '../server/modules/ops/time-log'
import { closeTestDb, createUser, databaseUrl, expectServiceError, verifiedAffiliation, withRollback } from './helpers'

const HOUR = 60 * 60 * 1000
const T0 = new Date('2093-03-02T01:00:00Z') // 서울 2093-03-02(월) 10:00
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR)
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const DB_TIMEOUT = 120_000
const PEPPER = { NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'community-ops-c10-analytics-pepper-0123456789abcdef' }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

type Person = { userId: string; displayName: string }

async function person(tx: DbExecutor, schoolId: string | null, label = '학생'): Promise<Person> {
  const displayName = `${label}${rand().slice(0, 5)}`
  const u = await createUser(tx, { displayName, handle: `o${rand()}` })
  if (schoolId) await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id, displayName }
}

async function world(tx: DbExecutor, members = 6, nameMode: 'anonymous' | 'display' = 'anonymous') {
  const op = await person(tx, null, '운영자')
  await tx.insert(operators).values({ userId: op.userId })
  const school = await createSchool(tx, op, { name: `운영지표대${rand()}학교`, confirmNew: true }, T0)
  const O = await person(tx, school.id, '방장')
  const roomName = `지표방 ${rand()}`
  const room = await createRoom(tx, O, { name: roomName, nameMode, joinPolicy: 'open' }, at(0))
  const people: Person[] = []
  for (let i = 0; i < members; i++) {
    const p = await person(tx, school.id, `멤버${i + 1}`)
    await joinSpace(tx, p, room.slug, at(0.1))
    people.push(p)
  }
  const [row] = await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.slug, room.slug))
  return { op, O, people, schoolId: school.id, room: { ...room, id: row!.id }, roomName, boardId: room.boards[0]!.id }
}

const reportPost = (tx: DbExecutor, who: Person, postId: string, when: Date) => createReport(tx, who, { targetType: 'community_post', targetRef: { postId }, reason: 'harassment' }, when)

describe.skipIf(!databaseUrl)('C-10 community operations (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => {
    setAnalyticsEnvForTesting(null)
    setAutoHideThresholdsForTesting(null)
    setReportSlaTargetsForTesting(null)
    setSpaceBreakdownMinMembersForTesting(null)
  })

  it('queue SLA: auto-hidden first with the 24h clock from hiding, ages, overdue filter, first action kept on reassignment; deep health counts', async () => {
    const root = path.join(process.env.TMPDIR ?? '/tmp', `peerchive-c10-${rand()}`)
    await withRollback(async (tx) => {
      const w = await world(tx, 4)
      const [A, B, C, D] = w.people as [Person, Person, Person, Person]
      const storage = createFilesystemStorage(root)
      const flags = { maintenance: false, publicReadsDisabled: false }
      const before = await deepHealth({ db: tx, storage, now: at(40), graceDays: 7, flags })

      const hidden = await createPost(tx, D, w.boardId, { title: '숨겨질 글', body: '본문' }, at(1))
      const normal = await createPost(tx, D, w.boardId, { title: '보통 글', body: '본문' }, at(1))
      const firstReport = await reportPost(tx, A, normal.id, at(2)) // 보통 신고(첫 신고 at 2)
      await reportPost(tx, A, hidden.id, at(2))
      await reportPost(tx, B, hidden.id, at(3))
      await reportPost(tx, C, hidden.id, at(4)) // 3번째 → 임시 숨김(at 4)
      const rows = await tx.select().from(reports).where(eq(reports.communityPostId, hidden.id))
      expect(rows.every((r) => r.autoHiddenAt?.getTime() === at(4).getTime())).toBe(true)
      expect((await tx.select().from(reports).where(eq(reports.communityPostId, normal.id)))[0]!.autoHiddenAt).toBeNull()

      // at 40: 숨김 36시간(목표 24 → 넘김), 보통 38시간(목표 72 → 여유)
      const mine = (await listReportGroups(tx, w.op, { status: 'open' }, at(40))).filter((g) => g.sla.startedAt >= T0.toISOString())
      const hiddenGroup = mine.find((g) => g.autoHidden)!
      const normalGroup = mine.find((g) => g.reportId === firstReport.id)!
      expect(hiddenGroup.sla).toMatchObject({ priority: 'auto_hidden', targetHours: 24, state: 'overdue', ageSeconds: 36 * 3600, startedAt: at(4).toISOString(), dueAt: at(28).toISOString() })
      expect(hiddenGroup.count).toBe(3)
      expect(normalGroup.sla).toMatchObject({ priority: 'normal', targetHours: 72, state: 'ok', ageSeconds: 38 * 3600, firstActionSeconds: null })
      expect(mine.indexOf(hiddenGroup)).toBeLessThan(mine.indexOf(normalGroup))
      // 우선순위: 처리 전 대기열에서 임시 숨김 묶음은 모든 보통 묶음보다 앞
      const all = await listReportGroups(tx, w.op, { status: 'open' }, at(40))
      const lastHidden = all.map((g) => g.sla.priority === 'auto_hidden' || g.autoHidden).lastIndexOf(true)
      const firstNormal = all.findIndex((g) => !(g.sla.priority === 'auto_hidden' || g.autoHidden))
      if (firstNormal >= 0) expect(lastHidden).toBeLessThan(firstNormal)
      // due_soon(75%): 보통 묶음 at 2 + 54h
      expect((await listReportGroups(tx, w.op, { status: 'open' }, at(56))).find((g) => g.reportId === firstReport.id)!.sla.state).toBe('due_soon')

      // 기한 넘김만
      const overdue = await listReportGroups(tx, w.op, { status: 'open', overdue: '1' }, at(40))
      expect(overdue.some((g) => g.reportId === hiddenGroup.reportId)).toBe(true)
      expect(overdue.some((g) => g.reportId === firstReport.id)).toBe(false)
      expect(overdue.every((g) => g.sla.state === 'overdue')).toBe(true)
      await expectServiceError(listReportGroups(tx, w.op, { status: 'resolved', overdue: '1' }, at(40)), 'VALIDATION')
      await expectServiceError(listReportGroups(tx, w.op, { status: 'open', overdue: 'yes' }, at(40)), 'VALIDATION')
      // 환경 설정으로 기한을 바꾸면 판정도 바뀜
      setReportSlaTargetsForTesting({ autoHiddenHours: 60, normalHours: 30 })
      const relaxed = await listReportGroups(tx, w.op, { status: 'open' }, at(40))
      expect(relaxed.find((g) => g.reportId === hiddenGroup.reportId)!.sla.state).toBe('ok')
      expect(relaxed.find((g) => g.reportId === firstReport.id)!.sla.state).toBe('overdue')
      setReportSlaTargetsForTesting(null)

      // 상세 상태 확인: 처리 전 +2, 기한 넘김 +1(임시 숨김 +1). 내용·id 없음
      const after = await deepHealth({ db: tx, storage, now: at(40), graceDays: 7, flags })
      expect(after.reports.open - before.reports.open).toBe(2)
      expect(after.reports.overdue - before.reports.overdue).toBe(1)
      expect(after.reports.overdueAutoHidden - before.reports.overdueAutoHidden).toBe(1)
      expect(after.reports.targets).toEqual({ autoHiddenHours: 24, normalHours: 72 })
      expect(JSON.stringify(after.reports)).not.toMatch(UUID)

      // 첫 조치: 배정(at 41) → 다시 배정(at 45)해도 그대로, 처리(at 50)
      await assignReport(tx, w.op, firstReport.id, at(41))
      const op2 = await person(tx, null, '운영자2')
      await tx.insert(operators).values({ userId: op2.userId })
      await assignReport(tx, op2, firstReport.id, at(45))
      const [assigned] = await tx.select().from(reports).where(eq(reports.id, firstReport.id))
      expect(assigned!.firstActionAt).toEqual(at(41))
      expect(assigned!.assignedAt).toEqual(at(45))
      await dismissReport(tx, w.op, firstReport.id, { note: '문제 없음' }, at(50))
      const closed = (await listReportGroups(tx, w.op, { status: 'dismissed' }, at(60))).find((g) => g.reportId === firstReport.id)!
      expect(closed.sla).toMatchObject({ firstActionSeconds: 39 * 3600, resolutionSeconds: 48 * 3600, state: 'ok', ageSeconds: 48 * 3600 })
      // 임시 숨김을 가리기로 처리: 처리 시각이 첫 조치(배정 없이 바로 처리)
      await resolveReport(tx, w.op, hiddenGroup.reportId, { action: 'hide_post', note: '확정', publicReason: '이용 규칙 위반', notifyOwner: true }, at(52))
      const resolved = (await listReportGroups(tx, w.op, { status: 'resolved' }, at(60))).find((g) => g.reportId === hiddenGroup.reportId)!
      expect(resolved.sla).toMatchObject({ priority: 'auto_hidden', state: 'overdue', firstActionSeconds: 50 * 3600, resolutionSeconds: 50 * 3600 })
    })
  }, DB_TIMEOUT)

  it('ops time log: operators only, own entries only, validation, upsert/delete, audit carries ids only', async () => {
    await withRollback(async (tx) => {
      const now = at(30)
      const week = isoWeekOf(now)
      const lastWeek = isoWeekOf(now, 1)
      const op = await person(tx, null, '운영자')
      const op2 = await person(tx, null, '운영자')
      const someone = await person(tx, null)
      await tx.insert(operators).values([{ userId: op.userId }, { userId: op2.userId }])
      const body = { minutes: { reports: 90, official_pages: 30, curation: 15 }, note: 'SENTINEL-메모' }

      await expectServiceError(listMyOpsTime(tx, someone, now), 'FORBIDDEN', 'operator_only')
      await expectServiceError(saveMyOpsTime(tx, someone, week, body, now), 'FORBIDDEN', 'operator_only')
      await expectServiceError(deleteMyOpsTime(tx, someone, week), 'FORBIDDEN', 'operator_only')

      const saved = await saveMyOpsTime(tx, op, week, body, now)
      expect(saved).toMatchObject({ week, minutes: { reports: 90, official_pages: 30, affiliation_support: 0, curation: 15, other: 0 }, total: 135, note: 'SENTINEL-메모' })
      const again = await saveMyOpsTime(tx, op, week, { minutes: { reports: 60 } }, now)
      expect(again).toMatchObject({ total: 60, note: null })
      await saveMyOpsTime(tx, op, lastWeek, { minutes: { other: 10 } }, now)
      expect((await tx.select().from(opsTimeEntries).where(eq(opsTimeEntries.operatorId, op.userId))).length).toBe(2)

      const mine = await listMyOpsTime(tx, op, now)
      expect(mine.currentWeek).toBe(week)
      expect(mine.entries.map((e) => e.week)).toEqual([week, lastWeek])
      // 다른 운영자는 내 기록을 볼 수 없음(본인 목록만, 지우기도 404)
      expect((await listMyOpsTime(tx, op2, now)).entries).toEqual([])
      await expectServiceError(deleteMyOpsTime(tx, op2, week), 'NOT_FOUND')

      const v = (p: Promise<unknown>, field: string, code: string) =>
        expectServiceError(p, 'VALIDATION').then((e) => expect(e.fields?.[field]).toBe(code))
      await v(saveMyOpsTime(tx, op, isoWeekOf(at(24 * 8)), body, now), 'week', 'future')
      await v(saveMyOpsTime(tx, op, isoWeekOf(now, 60), body, now), 'week', 'too_old')
      await v(saveMyOpsTime(tx, op, '2093-10', body, now), 'week', 'invalid')
      await v(saveMyOpsTime(tx, op, week, { minutes: { reports: 6000, other: 5000 } }, now), 'minutes', 'too_many')
      await v(saveMyOpsTime(tx, op, week, { minutes: { reports: -5 } }, now), 'minutes.reports', 'invalid')
      await v(saveMyOpsTime(tx, op, week, { minutes: { reports: 1.5 } }, now), 'minutes.reports', 'invalid')
      await expectServiceError(saveMyOpsTime(tx, op, week, { minutes: { reports: 5, hacking: 1 } }, now), 'VALIDATION')
      await v(saveMyOpsTime(tx, op, week, { minutes: {}, note: 'x'.repeat(201) }, now), 'note', 'too_long')

      await deleteMyOpsTime(tx, op, lastWeek)
      await expectServiceError(deleteMyOpsTime(tx, op, lastWeek), 'NOT_FOUND')
      await expectServiceError(deleteMyOpsTime(tx, op, 'nope'), 'NOT_FOUND')
      expect((await listMyOpsTime(tx, op, now)).entries.map((e) => e.week)).toEqual([week])

      const audit = await tx.select().from(auditEvents).where(sql`${auditEvents.action} like 'ops_time.%' and ${auditEvents.actorId} = ${op.userId}`)
      expect(audit.map((a) => a.action).sort()).toEqual(['ops_time.delete', 'ops_time.save', 'ops_time.save', 'ops_time.save'])
      for (const a of audit) {
        expect(a.metadata).toEqual({})
        expect(JSON.stringify(a)).not.toContain('SENTINEL')
      }
    })
  }, DB_TIMEOUT)

  it('community metrics: service flows + keyed/unkeyed event fixtures, suppression, moderation timings, ops time totals; operator-only', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const w = await world(tx, 6, 'anonymous')
      const [A, B, C, D, E, F] = w.people as [Person, Person, Person, Person, Person, Person]
      await expectServiceError(getCommunityMetrics(tx, A, {}), 'FORBIDDEN', 'operator_only')

      // 익명 글 6개(키 없는 post_created), 각각 3명이 신고 → 임시 숨김 6건, 5건 기각(복원) · 1건 가리기 확정
      const posts = []
      for (let i = 0; i < 6; i++) posts.push(await createPost(tx, F, w.boardId, { title: `SENTINEL 글 ${i}`, body: 'SENTINEL 본문' }, at(1 + i * 0.1)))
      const groupIds: string[] = []
      for (const [i, post] of posts.entries()) {
        const r = await reportPost(tx, A, post.id, at(2 + i * 0.1))
        groupIds.push(r.id)
        await reportPost(tx, B, post.id, at(2.2 + i * 0.1))
        await reportPost(tx, C, post.id, at(3 + i * 0.1)) // 숨김 at 3.x
      }
      expect((await tx.select({ s: communityPosts.status }).from(communityPosts).where(eq(communityPosts.id, posts[0]!.id)))[0]!.s).toBe('auto_hidden')
      for (const [i, id] of groupIds.entries()) {
        if (i < 5) await dismissReport(tx, w.op, id, { note: '문제 없음' }, at(13 + i * 0.1)) // 숨김 10시간 뒤
        else await resolveReport(tx, w.op, id, { action: 'hide_post', note: '확정', publicReason: '규칙 위반', notifyOwner: false }, at(13.5))
      }
      // 작성자 확인(신고와 이어짐) 1건 → 가림
      const lookup = await lookupAuthor(tx, w.op, { targetType: 'post', targetId: posts[5]!.id, reason: '확정된 글 작성자 제재 판단', reportId: groupIds[5] }, at(14))
      await issueSanction(tx, w.op, { lookupId: lookup.lookupId, level: 'warning', scope: 'space', note: '내부', publicReason: '경고' }, at(14.1))
      // 익명 댓글(키 없음)과 공감(익명 대상 → 키 없음)
      for (const p of [A, B, C, D, E]) await createComment(tx, p, posts[0]!.id, { body: 'SENTINEL 댓글' }, at(15))
      await setReaction(tx, D, 'post', posts[1]!.id, true, at(15))

      // 키 있는 행동 fixture(서로 다른 6명, 같은 주) + 질문 글·옮기기·모집 마감(이벤트만)
      const pepper = analyticsPepper()!
      const base = { hashKeyId: '0123abcd' }
      const keyed = Array.from({ length: 6 }, () => hashSubject(pepper, crypto.randomUUID()))
      const rows: Array<typeof analyticsEvents.$inferInsert> = []
      for (const h of keyed) rows.push({ ...base, name: 'post_created', actorHash: h, occurredAt: at(20), props: { kind: 'question', mode: 'display', area: 'official' } })
      for (let i = 0; i < 5; i++) rows.push({ ...base, name: 'archive_transfer_completed', actorHash: null, occurredAt: at(30), props: { target: 'course_qa' } })
      for (let i = 0; i < 5; i++) rows.push({ ...base, name: 'recruitment_closed', actorHash: keyed[i]!, occurredAt: at(31), props: { kind: 'study', outcome: 'study_room' } })
      await tx.insert(analyticsEvents).values(rows)
      // 주간 운영 시간: 두 운영자
      const op2 = await person(tx, null, '운영자2')
      await tx.insert(operators).values({ userId: op2.userId })
      await saveMyOpsTime(tx, w.op, isoWeekOf(at(1)), { minutes: { reports: 120, curation: 3 }, note: 'SENTINEL 메모' }, at(40))
      await saveMyOpsTime(tx, op2, isoWeekOf(at(1)), { minutes: { reports: 30 } }, at(40))

      const m = await getCommunityMetrics(tx, w.op, { from: '2093-03-02', to: '2093-03-08' }, at(24 * 10))
      // 키 있는 행동: fixture 6명 + 방 만들기(방장) + 가입 6명 = 13. 익명 글·댓글·공감·신고는 사람으로 세지 않음
      expect(m.activity.weeklyActive).toEqual([{ week: isoWeekOf(at(1)), users: 13 }])
      // 익명 글 6 + 표시명 질문 6
      expect(m.writing.posts).toBe(12)
      expect(m.writing.postsByMode).toEqual({ real: null, display: 6, anonymous: 6 })
      expect(m.writing.postsByBoard).toMatchObject({ question: 6, general: 6, free: null })
      expect(m.writing.comments).toBe(5)
      expect(m.writing.anonymousShare).toEqual({ numerator: 11, denominator: 17, rate: 0.647 })
      expect(m.activity.unkeyedEvents).toBeGreaterThanOrEqual(6 + 5 + 1 + 18 + 6 + 1 + 1 + 5)
      expect(m.moderation).toMatchObject({
        reportsFiled: 18,
        communityReportsFiled: 18,
        reportsPer100Posts: 150,
        casesClosed: 6,
        medianFirstActionHours: 11,
        medianAutoHiddenResolutionHours: 10,
        slaMet: { numerator: 6, denominator: 6, rate: 1 },
        autoHideRate: { numerator: 6, denominator: 6, rate: 1 },
        restoreRate: { numerator: 5, denominator: 6, rate: 0.833 },
        sanctionsByLevel: { warning: null, write_suspended: null, permanent: null },
        authorLookups: null,
      })
      expect(m.conversion.questionToStuck).toEqual({ numerator: 5, denominator: 6, rate: 0.833 })
      expect(m.conversion.transfers.course_qa).toEqual({ requested: null, completed: 5, rate: null })
      expect(m.conversion.studyRecordConversion).toEqual({ numerator: null, denominator: 5, rate: null })
      const week = m.opsTime.weeks.find((x) => x.week === isoWeekOf(at(1)))!
      expect(week).toEqual({ week: isoWeekOf(at(1)), minutes: { reports: 150, official_pages: null, affiliation_support: null, curation: null, other: null }, total: 153, operators: null })
      expect(m.space).toBeNull()
      expect(m.slaTargets).toEqual({ autoHiddenHours: 24, normalHours: 72 })
      expect(m.notAvailable.revisit.value).toBeNull()

      // 응답에 사람·공간·글 식별자 없음
      const text = JSON.stringify(m)
      for (const leak of ['SENTINEL', w.roomName, w.room.slug, w.op.userId, F.userId, F.displayName, ...posts.map((p) => p.id), ...keyed]) expect(text).not.toContain(leak)
      expect(text).not.toMatch(UUID)
    })
  }, DB_TIMEOUT)

  it('space breakdown only for an explicitly chosen space with at least N active members; CSV export has no ids/names/text, is rate-limited and audited', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const w = await world(tx, 6, 'display')
      for (const [i, p] of w.people.entries()) await createPost(tx, p, w.boardId, { title: `SENTINEL ${i}`, body: 'SENTINEL 본문' }, at(1))
      const range = { from: '2093-03-02', to: '2093-03-08' }

      expect(spaceBreakdownMinMembers({})).toBe(20)
      expect(spaceBreakdownMinMembers({ PEERCHIVE_METRICS_SPACE_MIN_MEMBERS: '3' })).toBe(20) // 하한 10
      expect(spaceBreakdownMinMembers({ PEERCHIVE_METRICS_SPACE_MIN_MEMBERS: '30' })).toBe(30)
      // 기본 20명: 7명 방은 409, 목록에도 없음
      await expectServiceError(getCommunityMetrics(tx, w.op, { ...range, space: w.room.id }, at(24 * 10)), 'CONFLICT', 'space_too_small')
      expect((await listMetricsSpaces(tx, w.op)).some((s) => s.id === w.room.id)).toBe(false)
      await expectServiceError(getCommunityMetrics(tx, w.op, { ...range, space: crypto.randomUUID() }, at(24 * 10)), 'NOT_FOUND')
      await expectServiceError(getCommunityMetrics(tx, w.op, { ...range, space: 'nope' }, at(24 * 10)), 'NOT_FOUND')
      await expectServiceError(listMetricsSpaces(tx, w.people[0]!), 'FORBIDDEN', 'operator_only')

      setSpaceBreakdownMinMembersForTesting(8)
      await expectServiceError(getCommunityMetrics(tx, w.op, { ...range, space: w.room.id }, at(24 * 10)), 'CONFLICT', 'space_too_small')
      setSpaceBreakdownMinMembersForTesting(7)
      expect((await listMetricsSpaces(tx, w.op)).find((s) => s.id === w.room.id)).toEqual({ id: w.room.id, name: w.roomName, kind: 'user_room' })
      const m = await getCommunityMetrics(tx, w.op, { ...range, space: w.room.id }, at(24 * 10))
      expect(m.space).toMatchObject({ kind: 'user_room', minMembers: 7, namedWriters: 6, postsByMode: { display: 6, anonymous: null, real: null }, reportCases: null })
      expect(JSON.stringify(m.space)).not.toContain(w.roomName)
      expect(JSON.stringify(m.space)).not.toMatch(UUID)

      // CSV: 공간별 값 없음, id·이름·글·해시 없음
      await expectServiceError(exportCommunityMetricsCsv(tx, w.people[0]!, range, at(24 * 10)), 'FORBIDDEN', 'operator_only')
      const { csv, filename } = await exportCommunityMetricsCsv(tx, w.op, range, at(24 * 10))
      expect(filename).toBe('peerchive-community-metrics-2093-03-02-2093-03-08.csv')
      expect(csv.split('\n')[0]).toBe('section,metric,dimension,value')
      expect(csv).toContain('writing,posts_by_mode,display,6')
      for (const leak of ['SENTINEL', w.roomName, w.room.slug, w.room.id, w.op.userId, ...w.people.flatMap((p) => [p.userId, p.displayName])]) expect(csv).not.toContain(leak)
      expect(csv).not.toMatch(UUID)
      expect(csv).not.toMatch(/[0-9a-f]{40,}/)
      const audit = await tx.select().from(auditEvents).where(sql`${auditEvents.action} = 'metrics.export' and ${auditEvents.actorId} = ${w.op.userId}`)
      expect(audit).toHaveLength(1)
      expect(audit[0]!.metadata).toEqual({ kind: 'community_csv' })
      // 시간당 10회
      for (let i = 0; i < 9; i++) await exportCommunityMetricsCsv(tx, w.op, range, at(24 * 10))
      await expectServiceError(exportCommunityMetricsCsv(tx, w.op, range, at(24 * 10)), 'RATE_LIMITED')
    })
  }, DB_TIMEOUT)

  it('analytics emitters: each community action emits its event; anonymous items, reports, hiding, lookups and sanctions carry no user key', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const anon = await world(tx, 3, 'anonymous')
      const [A, B, C] = anon.people as [Person, Person, Person]
      const post = await createPost(tx, A, anon.boardId, { title: '익명 글', body: '본문' }, at(1))
      await createComment(tx, B, post.id, { body: '익명 댓글' }, at(1.1))
      await setReaction(tx, C, 'post', post.id, true, at(1.2))
      const r = await reportPost(tx, B, post.id, at(2))
      await reportPost(tx, C, post.id, at(2.1))
      await reportPost(tx, anon.O, post.id, at(2.2)) // 3명 → 임시 숨김
      const lookup = await lookupAuthor(tx, anon.op, { targetType: 'post', targetId: post.id, reason: '제재 판단을 위한 확인', reportId: r.id }, at(3))
      await issueSanction(tx, anon.op, { lookupId: lookup.lookupId, level: 'warning', scope: 'space', note: '내부', publicReason: '경고' }, at(3.1))
      const named = await world(tx, 1, 'display')
      await createPost(tx, named.people[0]!, named.boardId, { title: '표시명 글', body: '본문' }, at(4))

      const events = await tx.select().from(analyticsEvents).where(sql`${analyticsEvents.occurredAt} >= ${T0.toISOString()}::timestamptz`)
      const by = (name: string) => events.filter((e) => e.name === name)
      const pepper = analyticsPepper()!
      // 키 있는 행동: 방 만들기·가입·표시명 글(그 사람의 키)
      expect(by('space_created').some((e) => e.actorHash === hashSubject(pepper, anon.O.userId) && e.props.kind === 'user_room')).toBe(true)
      expect(by('space_joined').some((e) => e.actorHash === hashSubject(pepper, A.userId))).toBe(true)
      const namedPost = by('post_created').find((e) => e.props.mode === 'display')!
      expect(namedPost).toMatchObject({ actorHash: hashSubject(pepper, named.people[0]!.userId), props: { kind: 'general', mode: 'display', area: 'room' } })
      // 키 없는 이벤트: 익명 글·댓글·익명 대상 공감·신고·임시 숨김·작성자 확인·제재
      const expectUnkeyed = (name: string, props: Record<string, unknown>) => {
        const list = by(name).filter((e) => Object.entries(props).every(([k, v]) => e.props[k] === v))
        expect(list.length, name).toBeGreaterThan(0)
        for (const e of list) {
          expect(e.actorHash, name).toBeNull()
          expect(e.projectHash, name).toBeNull()
        }
      }
      expectUnkeyed('post_created', { mode: 'anonymous', area: 'room', kind: 'general' })
      expectUnkeyed('comment_created', { mode: 'anonymous', reply: false })
      expectUnkeyed('reaction_added', { target: 'post' })
      expectUnkeyed('community_report_filed', { targetKind: 'post' })
      expectUnkeyed('community_auto_hidden', { targetKind: 'post' })
      expectUnkeyed('community_author_lookup', { basis: 'report' })
      expectUnkeyed('community_sanction_issued', { level: 'warning', scope: 'space' })
      expect(by('community_report_filed').length).toBe(3)
      // 사람 키는 이 사람들 중 익명으로 쓴 A·B·C에게 이어지지 않음(가입 이벤트 외)
      const anonHashes = new Set([A, B, C].map((p) => hashSubject(pepper, p.userId)))
      for (const e of events.filter((x) => x.name !== 'space_joined')) expect(anonHashes.has(e.actorHash ?? '')).toBe(false)
      for (const e of events) expect(JSON.stringify(e.props)).not.toMatch(/익명 글|본문|댓글/)
    })
  }, DB_TIMEOUT)
})

describe('C-10 analytics coverage (static)', () => {
  /** DELIVERY_PLAN §6.1 커뮤니티 분석 이벤트 → 구현 이름. 사용자 키 없이 기록해야 하는 이벤트는 unlinked: true로 내는지 소스로 확인합니다. */
  const MAP: Array<{ plan: string; event: string; unkeyed: 'always' | 'anonymous' | 'never' }> = [
    { plan: 'community_post_created', event: 'post_created', unkeyed: 'anonymous' },
    { plan: 'community_comment_created', event: 'comment_created', unkeyed: 'anonymous' },
    { plan: 'archive_transfer_requested', event: 'archive_transfer_requested', unkeyed: 'always' },
    { plan: 'archive_transfer_completed', event: 'archive_transfer_completed', unkeyed: 'always' },
    { plan: 'recruitment_closed', event: 'recruitment_closed', unkeyed: 'never' },
    { plan: 'study_room_created', event: 'space_created', unkeyed: 'never' },
    { plan: 'study_record_logged', event: 'log_saved', unkeyed: 'never' },
    { plan: 'report_filed', event: 'community_report_filed', unkeyed: 'always' },
    { plan: 'post_auto_hidden', event: 'community_auto_hidden', unkeyed: 'always' },
    { plan: 'sanction_issued', event: 'community_sanction_issued', unkeyed: 'always' },
    { plan: 'operator_identity_lookup', event: 'community_author_lookup', unkeyed: 'always' },
  ]
  const modules = path.resolve(__dirname, '../server/modules')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts')) files.push(full)
    }
  }
  walk(modules)
  const calls = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/emitAnalytics\([^;]*?name: '([a-z_]+)'[^;]*?\)/gs)].map((m) => ({ file: f, name: m[1]!, text: m[0] })))

  it('every §6.1 community event has an emitter with the required key policy and allowlisted props', () => {
    for (const row of MAP) {
      const mine = calls.filter((c) => c.name === row.event)
      expect(mine.length, row.plan).toBeGreaterThan(0)
      expect(ANALYTICS_PROP_SPECS[row.event as keyof typeof ANALYTICS_PROP_SPECS], row.plan).toBeDefined()
      if (row.unkeyed === 'always') for (const c of mine) expect(c.text, `${row.plan} in ${c.file}`).toMatch(/unlinked: true/)
      if (row.unkeyed === 'anonymous') for (const c of mine) expect(c.text, `${row.plan} in ${c.file}`).toMatch(/unlinked: mode === 'anonymous'/)
    }
    // study_room_created는 space_created(kind study_room), study_record_logged는 log_saved(origin study)
    expect(calls.some((c) => c.name === 'space_created' && /study_room/.test(c.text))).toBe(true)
    expect(calls.some((c) => c.name === 'log_saved' && /origin: 'study'/.test(c.text))).toBe(true)
    // §6.1 space_kind → post_created.area
    expect(calls.find((c) => c.name === 'post_created')!.text).toMatch(/area/)
  })
})
