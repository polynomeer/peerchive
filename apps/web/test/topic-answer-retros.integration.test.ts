/**
 * A-06 현직자 답변 이동·수료 회고 통합 테스트(DELIVERY_PLAN §4.3 A-06, PROOFU_EVOLUTION_PLAN §8.9.10·§8.9.11, SYSTEM_DESIGN §6.7.2, ADR 0043).
 *
 * - 토픽 답변 → 선배 노트(ArchiveTransfer 재사용): 이름 표시 네 가지(실명·표시명·익명·소속 표시 유지). 소속 표시 유지는 원 글에 고정된 문자열을
 *   그대로 복사하고(다시 계산하지 않음, 이후 회원 수·소속이 바뀌어도 그대로, DB 트리거가 바꾸기를 막음) 페르소나로 투영되지 않습니다(이벤트·처리기·원시 SQL).
 *   실명·표시명은 복사본(선배 노트)만 그 페르소나 활동이 되고, 공개 DTO·활동에 원 글·댓글·옮기기 id가 없습니다. 질문 글은 복사하지 않습니다.
 * - 수료 회고: 수료생만 쓰고, 별점·연봉·추천 점수 열·입력이 없고(스키마·입력 거부), 익명 회고에 A-05 임계값(기관 → 기관 유형 → 표시 안 함)을
 *   쓰는 순간 고정하며, 넓혀지면 기관 목록에 나오지 않고 넓혀졌는지는 작성자에게만. 읽기 범위·하나만·철회·신고·숨기기·이의제기·탈퇴 정리·고정 열.
 * - 플래그 꺼짐 404, 마이그레이션 산출(빈 DB migrate는 RUNBOOK 절차로 따로 확인).
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 기관·사용자만 봅니다.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPLETION_RETRO_QUESTIONS,
  institutionNameKey,
  isEvaluationFieldName,
  normalizeCompletionRetroAnswers,
} from '@peerchive/domain'
import {
  PERSONA_ACTIVITY_PROJECT_TOPIC,
  and,
  archiveTransfers,
  completionRetros,
  eq,
  gte,
  institutionAffiliations,
  isNull,
  operators,
  outboxEvents,
  personaActivities,
  schools,
  seniorNotes,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { createFilesystemStorage } from '@peerchive/files'
import { handlePersonaActivityProject } from '../../worker/src/persona-activities'
import { purgeAccount } from '../../worker/src/ops/purge'
import { createCourse, createSchool } from '../server/modules/catalog/catalog'
import { createArchiveTransfer, getArchiveOptions } from '../server/modules/community/archive-transfers'
import { createOfficialPage } from '../server/modules/community/official'
import { createComment, createPost, getPost } from '../server/modules/community/posts'
import { getSpaceDetail } from '../server/modules/community/spaces'
import { createTopic } from '../server/modules/community/topics'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { createSeniorNote, publishSeniorNote, updateSeniorNote } from '../server/modules/course-hub/senior-notes'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { updateRealName } from '../server/modules/identity/profiles'
import {
  createCompletionRetro,
  getCompletionRetroComposer,
  listCompletionRetros,
  listMyCompletionRetros,
  withdrawCompletionRetro,
} from '../server/modules/institutions/completion-retros'
import { verifiedCategoryCount } from '../server/modules/institutions/member-counts'
import { createAppeal, listMyModerationNotices } from '../server/modules/moderation/notices'
import { decideAppeal, resolveReport } from '../server/modules/moderation/operator'
import { createReport } from '../server/modules/moderation/reports'
import { listPersonaActivities } from '../server/modules/social/activities'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, insertRealProfile, testDb } from './helpers'

class Rollback extends Error {}
async function withRollback(fn: (tx: DbExecutor) => Promise<void>): Promise<void> {
  const error = await testDb()
    .transaction(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
    .catch((e: unknown) => e)
  if (!(error instanceof Rollback)) throw error
}

const T0 = new Date('2026-11-20T03:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const ALL_ON = { PEERCHIVE_FEATURE_P2_TOPICS: 'on', PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'on' }
const VERIFIED = new Date('2026-03-02T00:00:00Z')
const DB_TIMEOUT = 90_000
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

type Kind = 'university' | 'bootcamp' | 'training_program'
type Standing = 'student' | 'alumni'

async function institution(tx: DbExecutor, kind: Kind, name: string) {
  const unique = `${name}${rand()}`
  const [row] = await tx.insert(schools).values({ name: unique, nameKey: institutionNameKey(unique), kind }).returning({ id: schools.id, name: schools.name })
  return row!
}

/** 기관에 인증된 회원 n명(대학은 메일, 그 밖은 초대 코드). */
async function members(tx: DbExecutor, schoolId: string, kind: Kind, n: number, standing: Standing = 'alumni'): Promise<string[]> {
  if (n <= 0) return []
  const rows = await tx
    .insert(users)
    .values(Array.from({ length: n }, (_, i) => ({ displayName: `회원${i}`, privateEmail: `m${i}+${crypto.randomUUID()}@example.test`, status: 'active' as const })))
    .returning({ id: users.id })
  await tx.insert(institutionAffiliations).values(
    rows.map((r) => ({
      userId: r.id,
      schoolId,
      institutionKind: kind,
      method: kind === 'university' ? ('email' as const) : ('invite_code' as const),
      emailHash: kind === 'university' ? crypto.randomUUID().replace(/-/g, '').repeat(2) : null,
      emailDomain: kind === 'university' ? 'fixture.ac.kr' : null,
      standing,
      status: 'active' as const,
      verifiedAt: VERIFIED,
    })),
  )
  return rows.map((r) => r.id)
}

async function categoryAtLeast(tx: DbExecutor, kind: Kind, standing: Standing, n: number) {
  const have = await verifiedCategoryCount(tx, kind, standing)
  if (have < n) await members(tx, (await institution(tx, kind, '채움기관')).id, kind, n - have, standing)
}

/** 사람 한 명 + 소속(기수 선택). 반환: 소속 id. */
async function affiliate(tx: DbExecutor, userId: string, schoolId: string, kind: Kind, standing: Standing, cohortId: string | null = null) {
  const [row] = await tx
    .insert(institutionAffiliations)
    .values({
      userId,
      schoolId,
      institutionKind: kind,
      method: kind === 'university' ? 'email' : 'invite_code',
      emailHash: kind === 'university' ? crypto.randomUUID().replace(/-/g, '').repeat(2) : null,
      emailDomain: kind === 'university' ? 'fixture.ac.kr' : null,
      standing,
      cohortId,
      status: 'active',
      verifiedAt: VERIFIED,
    })
    .returning({ id: institutionAffiliations.id })
  return row!.id
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

async function failsWith(tx: DbExecutor, fn: (inner: DbExecutor) => Promise<unknown>): Promise<string | undefined> {
  try {
    await tx.transaction(async (sp) => {
      await fn(sp)
    })
    return undefined
  } catch (error) {
    return pgCode(error) ?? String(error)
  }
}

// ── 토픽 답변 → 선배 노트 ───────────────────────────────────────────────

/** 대학(졸업생 60명 — 기관 이름 표시), 과목 둘, 토픽, 현직자(실명·표시명 페르소나, 실명), 질문자. */
async function topicWorld(tx: DbExecutor) {
  const op = await createUser(tx, { displayName: '운영자' })
  await tx.insert(operators).values({ userId: op.id })
  const uni = await createSchool(tx, { userId: op.id }, { name: `현직대${rand()}학교`, confirmNew: true }, T0)
  await members(tx, uni.id, 'university', 60, 'alumni')
  await categoryAtLeast(tx, 'university', 'alumni', 60)
  const seniorUser = await createUser(tx, { displayName: `계정현직자${rand()}` })
  const senior = { userId: seniorUser.id }
  const realHandle = `r${rand()}`
  const real = await insertRealProfile(tx, senior.userId, realHandle)
  const display = await insertDisplayPersona(tx, senior.userId, `밤의현직자${rand()}`)
  await updateRealName(tx, senior, { realName: `실명${rand()}` })
  await affiliate(tx, senior.userId, uni.id, 'university', 'alumni')
  const askerUser = await createUser(tx, { displayName: '질문자' })
  const asker = { userId: askerUser.id }
  await affiliate(tx, asker.userId, uni.id, 'university', 'student')
  const courseA = await createCourse(tx, senior, uni.id, { title: `자료구조${rand()}`, confirmNew: true }, T0)
  const courseB = await createCourse(tx, senior, uni.id, { title: `운영체제${rand()}`, confirmNew: true }, T0)
  const t = await createTopic(tx, { userId: op.id }, { name: `백엔드 직무 ${rand()}`, category: 'role' }, T0)
  return { op: { userId: op.id }, uni, senior, real, display, asker, courseA: courseA.id, courseB: courseB.id, topic: t, board: t.boards[0]!.id }
}

type TopicWorld = Awaited<ReturnType<typeof topicWorld>>

/** 질문 글 + 현직자의 소속 표시 익명 답변. */
async function answered(tx: DbExecutor, w: TopicWorld, minute: number, scope: 'institution' | 'institution_kind' | 'none' = 'institution') {
  const post = await createPost(tx, w.asker, w.board, { title: `신입 백엔드 준비 ${rand()}`, body: '무엇부터 공부하나요?' }, at(minute))
  const marker = `ANS${rand()}`
  const thread = await createComment(tx, w.senior, post.id, { body: `현업에서는 ${marker} 먼저 봅니다.`, affiliationScope: scope }, at(minute + 1))
  const comment = thread.comments.find((c) => c.body?.includes(marker))!
  return { postId: post.id, comment, marker }
}

const noteInput = (courseId: string, commentId: string, displayMode: string, over: Record<string, unknown> = {}) => ({
  target: 'senior_note',
  courseId,
  commentId,
  answerKey: 'wishKnew',
  displayMode,
  noAnswersConfirmed: true,
  ...over,
})

/** 옮긴 초안에 답 하나를 더하고 게시합니다(게시 절차 그대로). */
async function publishMoved(tx: DbExecutor, w: TopicWorld, noteId: string, minute: number) {
  const [row] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, noteId))
  const updated = await updateSeniorNote(tx, w.senior, noteId, { expectedVersion: row!.version, answers: { ...(row!.answers as object), firstWeek: '첫 주에는 로그를 읽어 보세요.' } }, at(minute))
  return publishSeniorNote(tx, w.senior, noteId, { expectedVersion: updated.version, confirmWarnings: true }, at(minute + 1))
}

describe.skipIf(!databaseUrl)('A-06 topic answer → senior note (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ALL_ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it(
    'keep affiliation label: the frozen label is copied (not recomputed), the note shows only the label, never gets a persona or a projection',
    async () => {
      await withRollback(async (tx) => {
        const w = await topicWorld(tx)
        const a = await answered(tx, w, 1)
        expect(a.comment.affiliationLabel).toBe(`${w.uni.name} · 졸업생`)
        // 화면 선택지: 댓글 원본, 고정된 소속 표시, 막힘 Q&A·막힘 로그는 댓글에서 안 됨.
        const options = await getArchiveOptions(tx, w.senior, a.postId, at(3), a.comment.id)
        expect(options.source).toEqual({ kind: 'comment', commentId: a.comment.id, affiliated: true, affiliationLabel: a.comment.affiliationLabel })
        expect(options.targets).toEqual({ course_qa: 'comment_source', stuck_log: 'comment_source', senior_note: null })
        // 옮기기 직전에 회원이 줄어 지금 다시 계산하면 넓혀질 상황이 되어도, 복사하는 것은 원 글에 고정된 문자열입니다.
        await tx.update(institutionAffiliations).set({ status: 'expired' }).where(and(eq(institutionAffiliations.schoolId, w.uni.id), sql`${institutionAffiliations.userId} <> ${w.senior.userId}`))
        const t = await createArchiveTransfer(tx, w.senior, a.postId, noteInput(w.courseA, a.comment.id, 'affiliation'), at(4))
        expect(t).toMatchObject({ status: 'done', target: 'senior_note', includesAnswer: true })
        const [transferRow] = await tx.select().from(archiveTransfers).where(eq(archiveTransfers.id, t.id))
        expect(transferRow).toMatchObject({ sourcePostId: a.postId, sourceCommentId: a.comment.id, snapshot: null })
        const [note] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, transferRow!.seniorNoteId!))
        expect(note).toMatchObject({ displayMode: 'affiliation', affiliationLabel: `${w.uni.name} · 졸업생`, displayNameSnapshot: null, status: 'draft' })
        expect((note!.answers as Record<string, string>).wishKnew).toContain(a.marker)
        // 질문 글은 복사하지 않음
        expect(JSON.stringify(note!.answers)).not.toContain('무엇부터 공부하나요')

        const published = await publishMoved(tx, w, note!.id, 6)
        expect(published).toMatchObject({ status: 'published', displayMode: 'affiliation', publicLabel: `${w.uni.name} · 졸업생`, displayName: null })
        // 투영 요청 없음 + 처리기·원시 SQL로도 투영 불가
        const events = await tx
          .select({ payload: outboxEvents.payload })
          .from(outboxEvents)
          .where(and(eq(outboxEvents.topic, PERSONA_ACTIVITY_PROJECT_TOPIC), isNull(outboxEvents.dispatchedAt), gte(outboxEvents.createdAt, T0)))
        expect(events.filter((e) => (e.payload as { sourceId: string }).sourceId === note!.id)).toEqual([])
        expect(await handlePersonaActivityProject(tx, { sourceType: 'senior_note', sourceId: note!.id })).toBe(0)
        for (const personaId of [w.real.personaId, w.display.personaId]) {
          expect(await failsWith(tx, (i) => i.insert(personaActivities).values({ personaId, sourceType: 'senior_note', sourceId: note!.id, itemKind: 'notes_and_studies' }))).toBe('23514')
          expect(await listPersonaActivities(tx, personaId)).toEqual([])
        }
        // 공개 허브: 소속 표시만, 원 글·댓글·옮기기·사람 id 없음
        const hub = await getPublicCourseHub(tx, w.courseA, at(8))
        const shown = hub.seniorNotes.find((n) => n.id === note!.id)!
        expect(shown).toMatchObject({ author: `${w.uni.name} · 졸업생`, anonymous: true, affiliated: true })
        const json = JSON.stringify(hub)
        for (const leak of [a.postId, a.comment.id, t.id, w.senior.userId, w.real.personaId, w.display.personaId, w.topic.slug]) expect(json).not.toContain(leak)
        // 원 글에는 "옮겨짐" 표시가 없음(어느 답변이 옮겨졌는지 드러나지 않게)
        expect((await getPost(tx, w.senior, a.postId, at(9))).archive.archived).toBe(false)
        // 고정: 바꿀 수 없고(트리거) 비우기만
        expect(await failsWith(tx, (i) => i.update(seniorNotes).set({ affiliationLabel: '다른 학교 · 졸업생' }).where(eq(seniorNotes.id, note!.id)))).toBe('23514')
        // 원 글의 소속을 철회해도 노트 표시는 그대로
        await tx.update(institutionAffiliations).set({ status: 'revoked', revokedAt: at(10), revokedReason: 'user_removed' }).where(eq(institutionAffiliations.userId, w.senior.userId))
        const [still] = await tx.select({ label: seniorNotes.affiliationLabel }).from(seniorNotes).where(eq(seniorNotes.id, note!.id))
        expect(still!.label).toBe(`${w.uni.name} · 졸업생`)
      })
    },
    DB_TIMEOUT,
  )

  it(
    'real/display: only the copy is projected to that persona (no link to the original); anonymous: no projection; errors and the flag',
    async () => {
      await withRollback(async (tx) => {
        const w = await topicWorld(tx)
        const moved: Record<string, { noteId: string; postId: string; commentId: string; transferId: string }> = {}
        let minute = 1
        for (const [mode, course, extra] of [
          ['name', w.courseA, {}],
          ['display', w.courseA, { displayName: '현업 선배' }],
          ['anonymous', w.courseB, {}],
        ] as const) {
          const a = await answered(tx, w, minute)
          const t = await createArchiveTransfer(tx, w.senior, a.postId, noteInput(course, a.comment.id, mode, extra), at(minute + 2))
          const [row] = await tx.select().from(archiveTransfers).where(eq(archiveTransfers.id, t.id))
          await publishMoved(tx, w, row!.seniorNoteId!, minute + 3)
          moved[mode] = { noteId: row!.seniorNoteId!, postId: a.postId, commentId: a.comment.id, transferId: t.id }
          const [note] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, row!.seniorNoteId!))
          // 이름을 고른 복사본에는 소속 표시를 복사하지 않음(나중에 소속 표시로 바꿀 수도 없음)
          expect(note!.affiliationLabel).toBeNull()
          minute += 10
        }
        // worker가 하듯 outbox 처리
        const events = await tx
          .select({ payload: outboxEvents.payload })
          .from(outboxEvents)
          .where(and(eq(outboxEvents.topic, PERSONA_ACTIVITY_PROJECT_TOPIC), isNull(outboxEvents.dispatchedAt), gte(outboxEvents.createdAt, T0)))
        for (const e of events) await handlePersonaActivityProject(tx, e.payload)
        const realActs = await listPersonaActivities(tx, w.real.personaId)
        const displayActs = await listPersonaActivities(tx, w.display.personaId)
        expect(realActs.map((x) => [x.sourceType, x.sourceId])).toEqual([['senior_note', moved.name!.noteId]])
        expect(displayActs.map((x) => [x.sourceType, x.sourceId])).toEqual([['senior_note', moved.display!.noteId]])
        // 활동에 원 글·댓글·옮기기 id, 토픽 주소가 없음(복사본만)
        const acts = JSON.stringify([realActs, displayActs])
        for (const m of Object.values(moved)) for (const leak of [m.postId, m.commentId, m.transferId]) expect(acts).not.toContain(leak)
        expect(acts).not.toContain(w.topic.slug)
        // 익명 노트는 어떤 페르소나에도 없음
        const [anonActs] = (await tx.execute(sql`select count(*)::int as n from persona_activities where source_id = ${moved.anonymous!.noteId}`)) as unknown as Array<{ n: number }>
        expect(anonActs!.n).toBe(0)
        // 원 글·댓글 자체는 여전히 투영되지 않음
        const [orig] = (await tx.execute(
          sql`select count(*)::int as n from persona_activities where source_id in ${Object.values(moved).flatMap((m) => [m.postId, m.commentId])}`,
        )) as unknown as Array<{ n: number }>
        expect(orig!.n).toBe(0)
        // 공개 허브 DTO에도 원 글·옮기기 연결 없음
        const hubs = JSON.stringify([await getPublicCourseHub(tx, w.courseA, at(60)), await getPublicCourseHub(tx, w.courseB, at(60))])
        for (const m of Object.values(moved)) for (const leak of [m.postId, m.commentId, m.transferId]) expect(hubs).not.toContain(leak)

        // 고치기: 복사한 소속 표시가 없는 노트는 소속 표시 방식으로 바꿀 수 없음, 직접 만들기도 안 됨
        const [nameNote] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, moved.name!.noteId))
        await expectServiceError(updateSeniorNote(tx, w.senior, nameNote!.id, { expectedVersion: nameNote!.version, displayMode: 'affiliation' }, at(61)), 'VALIDATION')
        await expectServiceError(
          createSeniorNote(tx, w.senior, w.courseB, { displayMode: 'affiliation', answers: { firstWeek: '가', timeSink: '나' }, noAnswersConfirmed: true }, at(62)),
          'VALIDATION',
        )
      })
    },
    DB_TIMEOUT,
  )

  it(
    'rejects: comment for other targets, someone else’s answer, non-topic spaces, keep-label without a label, keep-label on a named source; 404 with the topics flag off',
    async () => {
      await withRollback(async (tx) => {
        const w = await topicWorld(tx)
        const a = await answered(tx, w, 1)
        const fail = async (actor: { userId: string }, postId: string, input: Record<string, unknown>, code: string, field?: [string, string]) => {
          const error = await createArchiveTransfer(tx, actor, postId, input, at(5)).then(
            () => null,
            (e: unknown) => e as { code: string; fields?: Record<string, string>; reason?: string },
          )
          expect(error, JSON.stringify(input)).not.toBeNull()
          expect(error!.code).toBe(code)
          if (field) expect(error!.fields?.[field[0]]).toBe(field[1])
        }
        await fail(w.senior, a.postId, { ...noteInput(w.courseA, a.comment.id, 'anonymous'), target: 'course_qa' }, 'VALIDATION', ['commentId', 'not_applicable'])
        await fail(w.asker, a.postId, noteInput(w.courseA, a.comment.id, 'anonymous'), 'FORBIDDEN')
        // 표시 안 함으로 쓴 답변은 유지할 소속 표시가 없음
        const none = await answered(tx, w, 10, 'none')
        expect(none.comment.affiliationLabel ?? null).toBeNull()
        await fail(w.senior, none.postId, noteInput(w.courseA, none.comment.id, 'affiliation'), 'VALIDATION', ['displayMode', 'label_unavailable'])
        // 토픽 밖(공식 학교 페이지)의 댓글은 이 경로가 없음, 이름 있는 원본에는 소속 표시 유지가 없음
        const official = await createOfficialPage(tx, w.op, { schoolId: w.uni.id, name: `현직 공식 ${rand()}` }, T0)
        const board = (await getSpaceDetail(tx, w.senior, official.slug, T0)).boards.find((b) => b.kind === 'free')!.id
        const p = await createPost(tx, w.senior, board, { title: '조언', body: '공식 페이지 글' }, at(20))
        const th = await createComment(tx, w.senior, p.id, { body: '공식 댓글' }, at(21))
        await fail(w.senior, p.id, noteInput(w.courseA, th.comments[0]!.id, 'anonymous'), 'VALIDATION', ['commentId', 'not_allowed'])
        await fail(w.senior, p.id, { target: 'senior_note', courseId: w.courseA, answerKey: 'wishKnew', displayMode: 'affiliation', noAnswersConfirmed: true }, 'VALIDATION', [
          'displayMode',
          'invalid',
        ])
        // 플래그가 꺼지면 토픽 공간 자체가 404(옮기기·선택지 모두)
        setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'on' })
        await expectServiceError(createArchiveTransfer(tx, w.senior, a.postId, noteInput(w.courseA, a.comment.id, 'affiliation'), at(30)), 'NOT_FOUND')
        await expectServiceError(getArchiveOptions(tx, w.senior, a.postId, at(30), a.comment.id), 'NOT_FOUND')
      })
    },
    DB_TIMEOUT,
  )
})

// ── 수료 회고 ────────────────────────────────────────────────────────────

const answers = { learned: '팀 프로젝트로 배포까지 해 봤습니다.', curriculum: '후반 4주는 프로젝트만 했습니다.' }

async function retroWorld(tx: DbExecutor) {
  const op = await createUser(tx, { displayName: '운영자' })
  await tx.insert(operators).values({ userId: op.id })
  const big = await institution(tx, 'bootcamp', '큰캠프')
  await members(tx, big.id, 'bootcamp', 55)
  const small = await institution(tx, 'bootcamp', '작은캠프')
  await members(tx, small.id, 'bootcamp', 3)
  await categoryAtLeast(tx, 'bootcamp', 'alumni', 60)
  const [cohort] = await tx.execute(sql`insert into institution_cohorts (school_id, label, label_key) values (${big.id}, '12기', '12기') returning id`) as unknown as Array<{ id: string }>
  const authorUser = await createUser(tx, { displayName: `계정수료생${rand()}` })
  const author = { userId: authorUser.id }
  await insertDisplayPersona(tx, author.userId, `밤의수료생${rand()}`)
  const bigAff = await affiliate(tx, author.userId, big.id, 'bootcamp', 'alumni', cohort!.id)
  const smallAff = await affiliate(tx, author.userId, small.id, 'bootcamp', 'alumni')
  const uni = await institution(tx, 'university', '회고대')
  const uniAff = await affiliate(tx, author.userId, uni.id, 'university', 'alumni')
  const readerUser = await createUser(tx, { displayName: '읽는이' })
  const reader = { userId: readerUser.id }
  await affiliate(tx, reader.userId, uni.id, 'university', 'student')
  const outsiderUser = await createUser(tx, { displayName: '인증없음' })
  const studentUser = await createUser(tx, { displayName: '수강생' })
  const studentAff = await affiliate(tx, studentUser.id, big.id, 'bootcamp', 'student')
  return {
    op: { userId: op.id },
    big,
    small,
    author,
    bigAff,
    smallAff,
    uniAff,
    reader,
    outsider: { userId: outsiderUser.id },
    student: { userId: studentUser.id },
    studentAff,
  }
}

describe.skipIf(!databaseUrl)('A-06 completion retrospectives (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ALL_ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('has no star rating, salary or recommendation score field: table columns, question keys and input', async () => {
    // 낱말 판정 자체
    for (const bad of ['star_rating', 'salaryRange', 'nps', 'recommend_score', 'pay', 'rating']) expect(isEvaluationFieldName(bad), bad).toBe(true)
    for (const ok of ['beforeStart', 'status', 'started_at', 'display_mode', 'learned']) expect(isEvaluationFieldName(ok), ok).toBe(false)
    for (const q of COMPLETION_RETRO_QUESTIONS) expect(isEvaluationFieldName(q), q).toBe(false)
    expect(normalizeCompletionRetroAnswers({ ...answers, rating: '5' })).toEqual({ ok: false, fields: { 'answers.rating': 'unknown' } })
    if (!databaseUrl) return
    const rows = (await testDb().execute(
      sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'completion_retros'`,
    )) as unknown as Array<{ column_name: string }>
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.map((r) => r.column_name).filter(isEvaluationFieldName)).toEqual([])
    // 숫자형 열은 하나도 없음(점수를 담을 자리 없음)
    const numeric = (await testDb().execute(
      sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'completion_retros' and data_type in ('integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision')`,
    )) as unknown as Array<{ column_name: string }>
    expect(numeric).toEqual([])
  })

  it(
    'writes per display mode with A-05 thresholds frozen at write time; readers, filters, author-only broadened flag, one per institution, withdraw',
    async () => {
      await withRollback(async (tx) => {
        const w = await retroWorld(tx)
        // 화면: 대학 소속은 쓸 수 없고 부트캠프 수료생 소속 둘만
        const composer = await getCompletionRetroComposer(tx, w.author)
        expect(composer.options.map((o) => o.affiliationId).sort()).toEqual([w.bigAff, w.smallAff].sort())
        const smallOption = composer.options.find((o) => o.affiliationId === w.smallAff)!
        expect(smallOption.anonymousPreviews.institution).toEqual({ label: '부트캠프 수료생', broadened: true })
        expect(JSON.stringify(composer)).not.toMatch(/"(count|members|verifiedMembers)"/)
        expect((await getCompletionRetroComposer(tx, w.student)).options).toEqual([])
        await expectServiceError(
          createCompletionRetro(tx, w.author, { affiliationId: w.uniAff, displayMode: 'name', answers, guidelinesConfirmed: true }, at(1)),
          'VALIDATION',
        )
        await expectServiceError(
          createCompletionRetro(tx, w.student, { affiliationId: w.studentAff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(1)),
          'VALIDATION',
        )
        // 평가 필드·확인 누락·답 부족·익명 기수
        for (const [extra, field] of [
          [{ rating: 5 }, 'rating'],
          [{ salary: '4000' }, 'salary'],
          [{ recommendScore: 9 }, 'recommendScore'],
        ] as const) {
          const e = await createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'name', answers, guidelinesConfirmed: true, ...extra }, at(1)).catch((x: unknown) => x as { fields: Record<string, string> })
          expect((e as { fields: Record<string, string> }).fields).toEqual({ [field]: 'unknown' })
        }
        await expectServiceError(createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'name', answers }, at(1)), 'VALIDATION')
        await expectServiceError(
          createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'name', answers: { learned: '하나' }, guidelinesConfirmed: true }, at(1)),
          'VALIDATION',
        )
        await expectServiceError(
          createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'anonymous', showCohort: true, answers, guidelinesConfirmed: true }, at(1)),
          'VALIDATION',
        )

        // 이름을 건 회고(표시명·기수): 기관 이름 범위
        const named = await createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'display', showCohort: true, answers, guidelinesConfirmed: true }, at(2))
        expect(named).toMatchObject({ anonymous: false, institutionLabel: `${w.big.name} · 수료생`, cohortLabel: '12기', institution: { id: w.big.id }, status: 'published', labelBroadened: false })
        await expectServiceError(
          createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(3)),
          'CONFLICT',
          'retro_exists',
        )
        // 익명 회고(작은 기관): 기관 유형으로 넓혀 고정, 기관 목록에 없음, 넓혀졌는지는 작성자에게만
        const anon = await createCompletionRetro(tx, w.author, { affiliationId: w.smallAff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(4))
        expect(anon).toMatchObject({ author: '익명 수료생', anonymous: true, institutionLabel: '부트캠프 수료생', cohortLabel: null, labelBroadened: true })
        const [anonRow] = await tx.select().from(completionRetros).where(eq(completionRetros.id, anon.id))
        expect(anonRow).toMatchObject({ labelScopeRequested: 'institution', labelScopeApplied: 'institution_kind', displayNameSnapshot: null })

        const readerList = await listCompletionRetros(tx, w.reader, {})
        expect(readerList.eligible).toBe(true)
        const seen = readerList.items.filter((i) => i.id === named.id || i.id === anon.id)
        expect(seen.map((i) => i.id).sort()).toEqual([named.id, anon.id].sort())
        const anonSeen = seen.find((i) => i.id === anon.id)!
        expect(anonSeen.institution).toBeNull()
        expect('labelBroadened' in anonSeen).toBe(false)
        const json = JSON.stringify(readerList)
        for (const leak of [w.author.userId, w.smallAff, w.bigAff, w.small.name]) expect(json).not.toContain(leak)
        expect((await listCompletionRetros(tx, w.reader, { institution: w.small.id })).items).toEqual([])
        expect((await listCompletionRetros(tx, w.reader, { institution: w.big.id })).items.map((i) => i.id)).toEqual([named.id])
        expect((await listCompletionRetros(tx, w.reader, { kind: 'bootcamp' })).items.map((i) => i.id)).toEqual(expect.arrayContaining([named.id, anon.id]))
        expect(readerList.institutions.map((i) => i.id)).toContain(w.big.id)
        expect(readerList.institutions.map((i) => i.id)).not.toContain(w.small.id)
        // 인증 없는 계정은 읽지 못함, 운영자는 읽음
        expect(await listCompletionRetros(tx, w.outsider, {})).toEqual({ eligible: false, items: [], institutions: [], nextBefore: null })
        expect((await listCompletionRetros(tx, w.op, {})).eligible).toBe(true)

        // 쓴 뒤 회원이 늘어도 표시는 그대로(고정), 고정 열 트리거
        await members(tx, w.small.id, 'bootcamp', 60)
        const [stillAnon] = await tx.select().from(completionRetros).where(eq(completionRetros.id, anon.id))
        expect(stillAnon!.institutionLabel).toBe('부트캠프 수료생')
        expect(await failsWith(tx, (i) => i.update(completionRetros).set({ institutionLabel: `${w.small.name} · 수료생` }).where(eq(completionRetros.id, anon.id)))).toBe('23514')
        expect(await failsWith(tx, (i) => i.update(completionRetros).set({ displayMode: 'name', displayNameSnapshot: '이름' }).where(eq(completionRetros.id, anon.id)))).toBe('23514')

        // 철회: 목록에서 빠지고 다시 쓸 수 있음
        await withdrawCompletionRetro(tx, w.author, named.id, at(10))
        expect((await listCompletionRetros(tx, w.reader, { institution: w.big.id })).items).toEqual([])
        await expectServiceError(withdrawCompletionRetro(tx, w.reader, anon.id, at(11)), 'NOT_FOUND')
        const again = await createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'name', answers, guidelinesConfirmed: true }, at(12))
        expect(again).toMatchObject({ author: expect.stringContaining('계정수료생'), institutionLabel: `${w.big.name} · 수료생`, cohortLabel: null })
        expect((await listMyCompletionRetros(tx, w.author)).map((r) => r.status).sort()).toEqual(['published', 'published', 'withdrawn'])
        // 페르소나 활동으로 가지 않음
        const [acts] = (await tx.execute(sql`select count(*)::int as n from persona_activities where source_id in (${named.id}, ${anon.id}, ${again.id})`)) as unknown as Array<{ n: number }>
        expect(acts!.n).toBe(0)
      })
    },
    DB_TIMEOUT,
  )

  it(
    'anonymous labels: institution name when the group is large, nothing when even the category is small (two-step threshold)',
    async () => {
      await withRollback(async (tx) => {
        const w = await retroWorld(tx)
        const big = await createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(1))
        expect(big).toMatchObject({ institutionLabel: `${w.big.name} · 수료생`, institution: { id: w.big.id }, labelBroadened: false })
        // 범주(교육 프로그램 수료생)도 작으면 표시 안 함 — 개발 DB의 다른 데이터와 무관하게 임계값을 크게 둠
        process.env.PEERCHIVE_AFFILIATION_LABEL_THRESHOLD = '10000'
        try {
          const program = await institution(tx, 'training_program', '작은과정')
          const aff = await affiliate(tx, w.author.userId, program.id, 'training_program', 'alumni')
          const none = await createCompletionRetro(tx, w.author, { affiliationId: aff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(2))
          // 작성자 본인의 응답에는 어느 기관의 회고인지와 넓혀졌다는 안내가, 읽는 사람에게는 표시도 기관도 없음
          expect(none).toMatchObject({ institutionLabel: null, institution: { id: program.id }, labelBroadened: true })
          const seen = (await listCompletionRetros(tx, w.reader, {})).items.find((i) => i.id === none.id)!
          expect(seen).toMatchObject({ institutionLabel: null, institution: null, author: '익명 수료생' })
          expect(JSON.stringify(seen)).not.toContain(program.name)
        } finally {
          delete process.env.PEERCHIVE_AFFILIATION_LABEL_THRESHOLD
        }
      })
    },
    DB_TIMEOUT,
  )

  it(
    'report → hide_retro → author notice → appeal reverses; flag off is 404 everywhere',
    async () => {
      await withRollback(async (tx) => {
        const w = await retroWorld(tx)
        const retro = await createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(1))
        await expectServiceError(createReport(tx, w.outsider, { targetType: 'completion_retro', targetRef: { retroId: retro.id }, reason: 'harassment' }, at(2)), 'NOT_FOUND')
        const receipt = await createReport(tx, w.reader, { targetType: 'completion_retro', targetRef: { retroId: retro.id }, reason: 'harassment' }, at(2))
        const resolved = await resolveReport(tx, w.op, receipt.id, { action: 'hide_retro', note: '강사 실명 비난', publicReason: '개인 평가', notifyOwner: true }, at(3))
        expect(resolved.content).toMatchObject({ kind: 'completion_retro', status: 'hidden' })
        expect(JSON.stringify(resolved.content)).not.toContain(w.author.userId)
        expect((await listCompletionRetros(tx, w.reader, {})).items.map((i) => i.id)).not.toContain(retro.id)
        const mine = await listMyCompletionRetros(tx, w.author)
        expect(mine.find((r) => r.id === retro.id)).toMatchObject({ status: 'hidden', moderation: { kind: 'hide_retro' } })
        const notices = await listMyModerationNotices(tx, w.author)
        const notice = notices.find((n) => n.kind === 'hide_retro')!
        expect(notice.ownerPath).toBe('/community/retros')
        const appeal = await createAppeal(tx, w.author, { actionId: notice.actionId, message: '경험만 적었습니다' }, at(4))
        await decideAppeal(tx, w.op, appeal.id, { decision: 'reverse', note: '확인' }, at(5))
        expect((await listCompletionRetros(tx, w.reader, {})).items.map((i) => i.id)).toContain(retro.id)

        setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2_TOPICS: 'on' })
        await expectServiceError(listCompletionRetros(tx, w.reader, {}), 'NOT_FOUND')
        await expectServiceError(getCompletionRetroComposer(tx, w.author), 'NOT_FOUND')
        await expectServiceError(listMyCompletionRetros(tx, w.author), 'NOT_FOUND')
        await expectServiceError(createCompletionRetro(tx, w.author, { affiliationId: w.smallAff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(6)), 'NOT_FOUND')
        await expectServiceError(withdrawCompletionRetro(tx, w.author, retro.id, at(6)), 'NOT_FOUND')
        await expectServiceError(createReport(tx, w.reader, { targetType: 'completion_retro', targetRef: { retroId: retro.id }, reason: 'spam' }, at(6)), 'NOT_FOUND')
      })
    },
    DB_TIMEOUT,
  )

  it(
    'account purge deletes the author’s retros, keeping a blank anonymous withdrawn row when a report points at it',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'peerchive-a06-purge-'))
      try {
        await withRollback(async (tx) => {
          const w = await retroWorld(tx)
          const reported = await createCompletionRetro(tx, w.author, { affiliationId: w.bigAff, displayMode: 'display', showCohort: true, answers, guidelinesConfirmed: true }, at(1))
          const plain = await createCompletionRetro(tx, w.author, { affiliationId: w.smallAff, displayMode: 'anonymous', answers, guidelinesConfirmed: true }, at(2))
          await createReport(tx, w.reader, { targetType: 'completion_retro', targetRef: { retroId: reported.id }, reason: 'spam' }, at(3))
          await tx.update(users).set({ status: 'deleted' }).where(eq(users.id, w.author.userId))
          const counts = await purgeAccount(
            tx,
            { storage: createFilesystemStorage(root), deletionPepper: 'a06-deletion-pepper-for-tests-0123456789abcdef', analyticsPepper: null },
            w.author.userId,
            { now: at(4), source: 'purge' },
          )
          expect(counts).toMatchObject({ completion_retros: 2 })
          expect(await tx.select().from(completionRetros).where(eq(completionRetros.id, plain.id))).toEqual([])
          const [kept] = await tx.select().from(completionRetros).where(eq(completionRetros.id, reported.id))
          expect(kept).toMatchObject({ status: 'withdrawn', displayMode: 'anonymous', displayNameSnapshot: null, cohortLabel: null, cohortId: null, answers: {} })
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    DB_TIMEOUT,
  )
})
