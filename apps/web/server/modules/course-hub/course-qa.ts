/**
 * 막힘 Q&A (C-09, PROOFU_EVOLUTION_PLAN §8.5·§8.9.8, SYSTEM_DESIGN §6.7 ArchiveTransfer·§8.2·§11, ADR 0025).
 *
 * 아카이브 쪽(과목 허브) 모듈입니다. **커뮤니티 테이블·모듈을 읽지 않습니다**(C-05 경계 검사가 이 디렉터리를 공개 읽기 경로로 확인).
 * - 만들기(`createCourseQaItemInTx`): 커뮤니티 옮기기가 두 사람의 동의를 모두 받은 트랜잭션에서 부릅니다(커뮤니티 → 아카이브 방향만).
 *   받는 값은 이미 복사된 글·고른 이름·당사자 id·불투명한 transfer id뿐이고, 이 모듈은 그 id로 커뮤니티 행을 찾지 않습니다.
 * - 공개 읽기: `status = 'published'`만 같은 쿼리에서 고릅니다(철회·숨김은 커밋 즉시 사라짐). 공개 DTO에는 복사한 글과 고른 이름만 있고
 *   당사자 id·transfer id·원 글 정보가 없습니다.
 * - 철회(`POST /course-qa/:id/withdraw`): 질문한 사람·답한 사람 누구나 언제든(운영 조치로 숨겨진 상태여도). 검색 문서·신호 정리는 worker.
 */
import type { CourseQaStatus } from '@peerchive/domain'
import {
  COURSE_QA_PUBLISHED_TOPIC,
  COURSE_QA_WITHDRAWN_TOPIC,
  and,
  courseQaItems,
  courses,
  desc,
  eq,
  inArray,
  or,
  outboxEvents,
  schools,
  sql,
  usefulnessSignals,
  type CourseQaOutboxPayload,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { type Actor, notFound } from '../errors'
import { isUuid } from '../projects/access'
import { courseScopeSql } from './public-scope'
import type { MyCourseQaDto, PublicCourseQaDto, SignalCountsDto } from '../../../shared/types/api'

export const HUB_QA_LIMIT = 50

type QaRow = typeof courseQaItems.$inferSelect

export const publicQaPath = (courseId: string, qaId: string) => `/c/${courseId}#qa-${qaId}`

const emptyCounts = (): SignalCountsDto => ({ meToo: 0, helped: 0 })

async function emit(tx: DbExecutor, topic: string, row: QaRow, now: Date) {
  const payload: CourseQaOutboxPayload = { courseQaItemId: row.id, courseId: row.courseId }
  await tx.insert(outboxEvents).values({ topic, payload: { ...payload }, createdAt: now })
}

export interface NewCourseQa {
  transferId: string
  courseId: string
  questionTitle: string
  questionBody: string
  answerBody: string
  asker: { userId: string; label: string; anonymous: boolean }
  answerer: { userId: string; label: string; anonymous: boolean }
}

/**
 * 동의가 모두 모인 옮기기 트랜잭션 안에서 막힘 Q&A 행을 만들고 곧바로 게시합니다(outbox `course_qa.published` → worker 색인).
 * 과목은 호출자가 정본으로 넘깁니다. 감사에는 행위자 없이 과목 id만 남깁니다(누가 동의했는지는 감사에 없음).
 */
export async function createCourseQaItemInTx(tx: DbExecutor, input: NewCourseQa, now: Date): Promise<string> {
  const [row] = await tx
    .insert(courseQaItems)
    .values({
      courseId: input.courseId,
      questionTitle: input.questionTitle,
      questionBody: input.questionBody,
      answerBody: input.answerBody,
      askerLabel: input.asker.label,
      askerAnonymous: input.asker.anonymous,
      answererLabel: input.answerer.label,
      answererAnonymous: input.answerer.anonymous,
      askerId: input.asker.userId,
      answererId: input.answerer.userId,
      status: 'published',
      transferId: input.transferId,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    })
    .returning()
  await emit(tx, COURSE_QA_PUBLISHED_TOPIC, row!, now)
  await recordAudit(tx, { actorId: null, action: 'course_qa.publish', targetType: 'course_qa', targetId: row!.id, metadata: { courseId: row!.courseId } })
  await emitAnalytics(tx, { name: 'course_qa_published', actorId: input.asker.userId, unlinked: true, props: {}, now })
  return row!.id
}

/** 항목별 신호 수(게시된 항목 id만 넘김). 작성자별 합계는 만들지 않습니다. */
export async function qaSignalCounts(db: DbExecutor, ids: readonly string[]): Promise<Map<string, SignalCountsDto>> {
  const out = new Map<string, SignalCountsDto>()
  if (ids.length === 0) return out
  const rows = await db
    .select({ id: usefulnessSignals.courseQaItemId, kind: usefulnessSignals.kind, n: sql<number>`count(*)::int` })
    .from(usefulnessSignals)
    .where(inArray(usefulnessSignals.courseQaItemId, [...ids]))
    .groupBy(usefulnessSignals.courseQaItemId, usefulnessSignals.kind)
  for (const r of rows) {
    const counts = out.get(r.id!) ?? emptyCounts()
    if (r.kind === 'me_too') counts.meToo = r.n
    else counts.helped = r.n
    out.set(r.id!, counts)
  }
  return out
}

export function toPublicCourseQa(row: QaRow, signals: SignalCountsDto): PublicCourseQaDto {
  return {
    id: row.id,
    questionTitle: row.questionTitle,
    questionBody: row.questionBody,
    answerBody: row.answerBody,
    asker: row.askerLabel,
    askerAnonymous: row.askerAnonymous,
    answerer: row.answererLabel,
    answererAnonymous: row.answererAnonymous,
    publishedAt: row.publishedAt.toISOString(),
    signals,
  }
}

/** 과목(정본 + 병합된 id)의 게시된 막힘 Q&A(최근 순). 상태는 같은 쿼리에서 확인합니다. */
export async function publishedCourseQa(db: DbExecutor, canonicalCourseId: string, limit = HUB_QA_LIMIT): Promise<PublicCourseQaDto[]> {
  const rows = await db
    .select()
    .from(courseQaItems)
    .where(and(eq(courseQaItems.status, 'published'), sql`${courseQaItems.courseId} in ${courseScopeSql(canonicalCourseId)}`))
    .orderBy(desc(courseQaItems.publishedAt), desc(courseQaItems.id))
    .limit(limit)
  const signals = await qaSignalCounts(db, rows.map((r) => r.id))
  return rows.map((r) => toPublicCourseQa(r, signals.get(r.id) ?? emptyCounts()))
}

/** 지금 게시 중인 항목 하나(신호·신고 대상 확인용). 아니면 null. */
export async function loadPublishedCourseQa(db: DbExecutor, id: unknown): Promise<QaRow | null> {
  if (!isUuid(id)) return null
  const [row] = await db
    .select()
    .from(courseQaItems)
    .where(and(eq(courseQaItems.id, id.toLowerCase()), eq(courseQaItems.status, 'published')))
    .limit(1)
  return row ?? null
}

function roleOf(row: Pick<QaRow, 'askerId' | 'answererId'>, userId: string): 'asker' | 'answerer' | null {
  if (row.askerId === userId) return 'asker'
  if (row.answererId === userId) return 'answerer'
  return null
}

async function toMine(db: DbExecutor, rows: QaRow[], userId: string): Promise<MyCourseQaDto[]> {
  const courseIds = [...new Set(rows.map((r) => r.courseId))]
  const labels = courseIds.length
    ? await db
        .select({ id: courses.id, title: courses.title, schoolName: schools.name })
        .from(courses)
        .innerJoin(schools, eq(schools.id, courses.schoolId))
        .where(inArray(courses.id, courseIds))
    : []
  const byId = new Map(labels.map((c) => [c.id, c]))
  return rows.map((r) => ({
    id: r.id,
    course: byId.get(r.courseId) ?? { id: r.courseId, title: '', schoolName: '' },
    questionTitle: r.questionTitle,
    role: roleOf(r, userId)!,
    myLabel: roleOf(r, userId) === 'asker' ? r.askerLabel : r.answererLabel,
    status: r.status as CourseQaStatus,
    publishedAt: r.publishedAt.toISOString(),
    withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    path: r.status === 'published' ? publicQaPath(r.courseId, r.id) : null,
  }))
}

/** GET /me/course-qa — 내가 질문했거나 답한 막힘 Q&A(철회 버튼용). 상대가 누구인지는 없습니다. */
export async function listMyCourseQa(db: DbExecutor, actor: Actor): Promise<MyCourseQaDto[]> {
  const rows = await db
    .select()
    .from(courseQaItems)
    .where(or(eq(courseQaItems.askerId, actor.userId), eq(courseQaItems.answererId, actor.userId)))
    .orderBy(desc(courseQaItems.publishedAt), desc(courseQaItems.id))
    .limit(100)
  return toMine(db, rows, actor.userId)
}

/** 당사자에게 보이는 한 항목(옮기기 화면이 상태를 보여 줄 때). 당사자가 아니면 null. */
export async function courseQaForParty(db: DbExecutor, actor: Actor, id: string): Promise<MyCourseQaDto | null> {
  const [row] = await db.select().from(courseQaItems).where(eq(courseQaItems.id, id)).limit(1)
  if (!row || !roleOf(row, actor.userId)) return null
  return (await toMine(db, [row], actor.userId))[0] ?? null
}

/**
 * POST /course-qa/:id/withdraw — 질문한 사람·답한 사람 누구나. 200(이미 철회도 200). 당사자가 아니거나 없으면 404.
 * 게시 중이거나 운영 조치로 숨겨진 항목을 철회합니다(숨김 되돌림은 published로 돌리지 않음: withdrawn이 우선).
 */
export async function withdrawCourseQa(db: DbExecutor, actor: Actor, id: unknown, now = new Date()): Promise<MyCourseQaDto> {
  if (!isUuid(id)) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(courseQaItems).where(eq(courseQaItems.id, id.toLowerCase())).limit(1).for('update')
    const role = row ? roleOf(row, actor.userId) : null
    if (!row || !role) throw notFound()
    if (row.status === 'withdrawn') return (await toMine(tx, [row], actor.userId))[0]!
    const [updated] = await tx
      .update(courseQaItems)
      .set({ status: 'withdrawn', withdrawnAt: now, withdrawnBy: role, updatedAt: now })
      .where(eq(courseQaItems.id, row.id))
      .returning()
    await emit(tx, COURSE_QA_WITHDRAWN_TOPIC, updated!, now)
    await recordAudit(tx, { actorId: actor.userId, action: 'course_qa.withdraw', targetType: 'course_qa', targetId: row.id, metadata: { role } })
    return (await toMine(tx, [updated!], actor.userId))[0]!
  })
}

