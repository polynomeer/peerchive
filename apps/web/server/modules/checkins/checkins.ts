/**
 * 주간 체크인 (T-09, PROOFU_EVOLUTION_PLAN §6.4, SYSTEM_DESIGN §6.3 WeeklyCheckin·§11.2, pilot-kit §3, ADR 0009).
 *
 * - 60초 폼: 이번 주 투입 시간(0/~2h/~5h/~10h/10h+), 체감 난이도(1~5), 한 줄(선택, 200자), 기록을 못 한 이유(복수, 선택),
 *   통계 공유 동의(따로, 기본 꺼짐). 주는 서울 기준 ISO 주(`YYYY-Www`)이며 이번 주와 지난주만 쓰고 고칠 수 있습니다
 *   (그 밖은 422 `{week: 'out_of_range'}`).
 * - 한 사람·한 프로젝트·한 주에 하나. 다시 내면 덮어씁니다(upsert, last-write-wins: 본인만 고치므로 version을 두지 않음).
 * - active 멤버면 누구나(viewer 포함) 냅니다. 읽을 수 없는 프로젝트는 404.
 * - 보이는 범위: 팀(active 멤버)은 이 주에 누가 냈는지와 각자의 투입 시간·난이도·한 줄을 봅니다(과제 공간 밖으로는 안 나감).
 *   통계 공유 여부와 기록을 못 한 이유는 본인에게만 보입니다.
 * - "이 한 줄을 빌드 로그로 옮기기"(promote): 🔨진행(본문=한 줄) 또는 🧱막힘(증상=한 줄, 막힌 시간=체크인 시간 구간에서
 *   가장 가까운 값). logs.ts의 parseLogInput·insertLog를 그대로 쓰므로 쓰기 권한(owner/editor)이 없으면 403이고,
 *   체크인마다 한 번만 만듭니다(clientId = UUID v5(체크인 id)). 이후 한 줄을 고쳐도 로그는 바뀌지 않습니다.
 */
import { z } from 'zod'
import {
  CHECKIN_DIFFICULTY_MAX,
  CHECKIN_DIFFICULTY_MIN,
  CHECKIN_NOTE_MAX,
  CHECKIN_SKIP_REASONS,
  CHECKIN_TIME_BUCKETS,
  STUCK_TIME_BUCKET_FROM_CHECKIN,
  checkCheckinWeek,
  isoWeekOf,
  isoWeekRange,
  orderMembersByName,
} from '@peerchive/domain'
import {
  and,
  asc,
  eq,
  profiles,
  projectMembers,
  projects,
  users,
  weeklyCheckins,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { type Actor, invalid } from '../errors'
import { getLog, insertLog, parseLogInput } from '../logs/logs'
import { loadPersonMask, loadReadableProject } from '../projects/access'
import { parseInput } from '../validation'
import { checkinClientId } from '../discord/client-id'
import type {
  CheckinDto,
  CheckinSaveDto,
  CheckinWeekDto,
  LogDto,
  MyCheckinDto,
  MyCheckinStatusDto,
  TeamCheckinEntryDto,
} from '../../../shared/types/api'

type CheckinRow = typeof weeklyCheckins.$inferSelect

const weekSchema = z.string({ error: 'invalid' }).regex(/^\d{4}-W\d{2}$/, { error: 'invalid_format' })

export const weekQuerySchema = z.object({ week: weekSchema.optional() })

export const putCheckinSchema = z.object({
  week: weekSchema.optional(),
  timeBucket: z.enum(CHECKIN_TIME_BUCKETS, { error: 'required' }),
  difficulty: z
    .number({ error: 'required' })
    .int({ error: 'invalid' })
    .min(CHECKIN_DIFFICULTY_MIN, { error: 'invalid' })
    .max(CHECKIN_DIFFICULTY_MAX, { error: 'invalid' }),
  note: z
    .string({ error: 'invalid' })
    .trim()
    .max(CHECKIN_NOTE_MAX, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v : null)),
  shareForStats: z.boolean({ error: 'invalid' }).default(false),
  skipReasons: z
    .array(z.enum(CHECKIN_SKIP_REASONS, { error: 'invalid' }), { error: 'invalid' })
    .max(CHECKIN_SKIP_REASONS.length, { error: 'too_many' })
    .default([])
    .transform((list) => [...new Set(list)]),
  /** 한 줄을 빌드 로그로 옮기기(선택). */
  promote: z.object({ tag: z.enum(['progress', 'stuck'], { error: 'invalid' }) }, { error: 'invalid' }).nullish(),
})

function toCheckinDto(row: CheckinRow): CheckinDto {
  return {
    id: row.id,
    projectId: row.projectId,
    week: row.isoWeek,
    timeBucket: row.timeBucket,
    difficulty: row.difficulty,
    note: row.note,
    shareForStats: row.shareForStats,
    skipReasons: row.skipReasons as CheckinDto['skipReasons'],
    promotedLogId: row.promotedLogEntryId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 쿼리의 주(없으면 이번 주). 형식이 틀리거나 없는 주면 422. */
function resolveWeek(week: string | undefined, now: Date): { week: string; from: string; to: string } {
  const value = week ?? isoWeekOf(now)
  const range = isoWeekRange(value)
  if (!range) throw invalid({ week: 'invalid_format' })
  return { week: value, ...range }
}

async function findCheckin(db: DbExecutor, projectId: string, userId: string, week: string) {
  const [row] = await db
    .select()
    .from(weeklyCheckins)
    .where(and(eq(weeklyCheckins.projectId, projectId), eq(weeklyCheckins.userId, userId), eq(weeklyCheckins.isoWeek, week)))
    .limit(1)
  return row ?? null
}

export async function getMyCheckin(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawQuery: unknown,
  now = new Date(),
): Promise<MyCheckinDto> {
  const query = parseInput(weekQuerySchema, rawQuery)
  const { project } = await loadReadableProject(db, actor, projectId)
  const week = resolveWeek(query.week, now)
  const row = await findCheckin(db, project.id, actor.userId, week.week)
  return { ...week, checkin: row ? toCheckinDto(row) : null }
}

export interface SavedCheckin extends CheckinSaveDto {
  created: boolean
}

export async function saveMyCheckin(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<SavedCheckin> {
  const input = parseInput(putCheckinSchema, rawInput)
  const week = input.week ?? isoWeekOf(now)
  const weekCheck = checkCheckinWeek(week, now)
  if (weekCheck !== 'ok') throw invalid({ week: weekCheck === 'invalid' ? 'invalid_format' : 'out_of_range' })
  if (input.promote && !input.note) throw invalid({ note: 'required' })

  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId)
    const created = !(await findCheckin(tx, project.id, actor.userId, week))
    const [saved] = await tx
      .insert(weeklyCheckins)
      .values({
        projectId: project.id,
        userId: actor.userId,
        isoWeek: week,
        timeBucket: input.timeBucket,
        difficulty: input.difficulty,
        note: input.note,
        shareForStats: input.shareForStats,
        skipReasons: input.skipReasons,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [weeklyCheckins.projectId, weeklyCheckins.userId, weeklyCheckins.isoWeek],
        set: {
          timeBucket: input.timeBucket,
          difficulty: input.difficulty,
          note: input.note,
          shareForStats: input.shareForStats,
          skipReasons: input.skipReasons,
          updatedAt: now,
        },
      })
      .returning()
    if (!saved) throw new Error('checkin upsert failed')
    let row = saved

    let log: LogDto | null = null
    if (input.promote && row.promotedLogEntryId) {
      log = await getLog(tx, actor, row.promotedLogEntryId)
    } else if (input.promote && row.note) {
      const raw =
        input.promote.tag === 'stuck'
          ? { tag: 'stuck', payload: { symptom: row.note, timeBucket: STUCK_TIME_BUCKET_FROM_CHECKIN[row.timeBucket] } }
          : { tag: 'progress', body: row.note }
      const parsed = parseLogInput({ ...raw, clientId: checkinClientId(row.id) }, now)
      log = (await insertLog(tx, actor, project, membership, parsed, 'web', now)).log
      const [updated] = await tx
        .update(weeklyCheckins)
        .set({ promotedLogEntryId: log.id })
        .where(eq(weeklyCheckins.id, row.id))
        .returning()
      if (updated) row = updated
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'checkin.submit',
      targetType: 'checkin',
      targetId: row.id,
      projectId: project.id,
      metadata: { week, promoted: !!log },
    })
    await emitAnalytics(tx, {
      name: 'checkin_submitted',
      actorId: actor.userId,
      projectId: project.id,
      props: { timeBucket: row.timeBucket, difficulty: row.difficulty, shareForStats: row.shareForStats, promoted: !!log, skipReasons: Math.min(row.skipReasons.length, 5) },
    })
    return { checkin: toCheckinDto(row), log, created }
  })
}

/** 팀 체크인 현황(이번 주 기본). active 멤버 이름순, 안 낸 멤버도 줄로 보여 줍니다. */
export async function listCheckins(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawQuery: unknown,
  now = new Date(),
): Promise<CheckinWeekDto> {
  const query = parseInput(weekQuerySchema, rawQuery)
  const { project } = await loadReadableProject(db, actor, projectId)
  const week = resolveWeek(query.week, now)
  const [members, rows] = await Promise.all([
    db
      .select({ userId: projectMembers.userId, displayName: users.displayName, handle: profiles.handle })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .leftJoin(profiles, eq(profiles.userId, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.status, 'active'))),
    db
      .select()
      .from(weeklyCheckins)
      .where(and(eq(weeklyCheckins.projectId, project.id), eq(weeklyCheckins.isoWeek, week.week))),
  ])
  const byUser = new Map(rows.map((row) => [row.userId, row]))
  // 익명 스터디 기록(C-08)은 다른 멤버 이름을 가립니다(이름순 정렬도 가린 이름 기준).
  const mask = await loadPersonMask(db, project, actor.userId)
  const entries: TeamCheckinEntryDto[] = orderMembersByName(members.map(mask)).map((member) => {
    const row = byUser.get(member.userId)
    return {
      member: { userId: member.userId, displayName: member.displayName, handle: member.handle },
      submitted: !!row,
      timeBucket: row?.timeBucket ?? null,
      difficulty: row?.difficulty ?? null,
      note: row?.note ?? null,
      promotedLogId: row?.promotedLogEntryId ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    }
  })
  return { ...week, entries }
}

/** 대시보드 "이번 주 체크인": 내가 active 멤버인 프로젝트별 제출 여부. */
export async function myCheckinStatus(db: DbExecutor, actor: Actor, now = new Date()): Promise<MyCheckinStatusDto> {
  const week = isoWeekOf(now)
  const rows = await db
    .select({ projectId: projects.id, title: projects.title, checkinId: weeklyCheckins.id })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .leftJoin(
      weeklyCheckins,
      and(
        eq(weeklyCheckins.projectId, projects.id),
        eq(weeklyCheckins.userId, actor.userId),
        eq(weeklyCheckins.isoWeek, week),
      ),
    )
    .where(and(eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active')))
    .orderBy(asc(projects.title), asc(projects.id))
  return { week, projects: rows.map((row) => ({ projectId: row.projectId, title: row.title, submitted: !!row.checkinId })) }
}
