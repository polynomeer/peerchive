/**
 * 이름 표시 방식 변경 적용(C-03, SYSTEM_DESIGN §6.7 NameModeChange "worker가 effective_at에 current_name_mode를 바꿈", ADR 0020).
 *
 * 주기 작업 `name-mode-changes`(기본 1분마다)가 effective_at이 지난 scheduled 예약을 적용합니다.
 * - 예약마다 트랜잭션 하나: 공간 행 잠금 → `update … set status = 'applied' where id = ? and status = 'scheduled' and effective_at <= now`
 *   (조건부라 여러 worker·재시도·수동 실행이 겹쳐도 한 번만 적용) → current_name_mode 바꾸기 → 지금 active 멤버에게 알림(같은 변경·종류·사람에
 *   한 행, on conflict do nothing) → 감사 `community.name_mode_apply` → 분석 `name_mode_applied{from,to}`(예약한 사람이 있고 수집 거부가 아닐 때).
 * - 공간이 보관·제한 상태여도 적용합니다(예약은 이미 알렸고, 되살아나면 그 방식으로 씀). 공식 페이지에는 예약이 생기지 않습니다(웹이 막고,
 *   공간 행 check가 anonymous 아닌 공식 페이지를 거부).
 * - 이미 쓴 글·댓글은 작성 시점 방식을 가지므로 여기서 건드리지 않습니다(소급 0건).
 * - 웹(apps/web/server/modules/community/notices.ts)과 같은 알림 SQL 모양·허용 목록(@peerchive/domain sanitizeNoticePayload)을 씁니다.
 *
 * 테스트·E2E는 `applyDueNameModeChanges(db, { now })`를 직접 부르거나 `pnpm --filter worker apply-name-modes`로 한 번 실행합니다.
 */
import { sanitizeAnalyticsProps, sanitizeNoticePayload } from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  asc,
  auditEvents,
  communitySpaces,
  eq,
  hashSubject,
  inArray,
  lte,
  directoryEntries,
  nameModeChanges,
  pepperKeyId,
  projects,
  roomProfileCohortChanges,
  roomProfiles,
  sql,
  studyRecords,
  users,
  type DbExecutor,
} from '@peerchive/db'
import type { TaskOutcome } from './cleanup'

export interface ApplyNameModeOptions {
  now: Date
  /** 분석 pepper(없으면 분석 이벤트를 건너뜀). */
  analyticsPepper?: string | null
  /** 한 번에 적용할 최대 예약 수(나머지는 다음 주기). */
  limit?: number
}

export interface AppliedChange {
  changeId: string
  spaceId: string
  notified: number
}

/** 예약 하나를 적용합니다. 이미 적용·취소됐거나 아직 기한 전이면 null(아무것도 바꾸지 않음). */
export async function applyNameModeChange(db: DbExecutor, changeId: string, options: ApplyNameModeOptions): Promise<AppliedChange | null> {
  const { now } = options
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ spaceId: nameModeChanges.spaceId }).from(nameModeChanges).where(eq(nameModeChanges.id, changeId)).limit(1)
    if (!peek) return null
    // 웹의 예약·취소와 같은 순서로 공간 행을 먼저 잠급니다.
    await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.id, peek.spaceId)).limit(1).for('update')
    const [change] = await tx
      .update(nameModeChanges)
      .set({ status: 'applied', appliedAt: now })
      .where(and(eq(nameModeChanges.id, changeId), eq(nameModeChanges.status, 'scheduled'), lte(nameModeChanges.effectiveAt, now)))
      .returning()
    if (!change) return null
    await tx.update(communitySpaces).set({ currentNameMode: change.toMode, updatedAt: now }).where(eq(communitySpaces.id, change.spaceId))
    // 스터디 기록(C-08, ADR 0026): 과제 행에 옮겨 둔 방식도 같은 트랜잭션에서 바꿉니다. 이미 만든 공개 후보·release는 만들 때의 방식 그대로입니다.
    await tx
      .update(projects)
      .set({ studyNameMode: change.toMode, updatedAt: now })
      .where(inArray(projects.id, tx.select({ id: studyRecords.projectId }).from(studyRecords).where(eq(studyRecords.spaceId, change.spaceId))))
    // 동문회·OB 방(A-01, ADR 0038): 익명 방에는 방별 프로필이 없습니다. 익명으로 바뀌면 프로필과 기수 이력을 지웁니다(되돌려도 살아나지 않음).
    if (change.toMode === 'anonymous') {
      await tx.delete(roomProfileCohortChanges).where(eq(roomProfileCohortChanges.spaceId, change.spaceId))
      await tx.delete(roomProfiles).where(eq(roomProfiles.spaceId, change.spaceId))
      // 멤버 명부(A-03, ADR 0040): 익명 방에는 명부가 없습니다. 동의 행도 지웁니다(되돌려도 살아나지 않음 — 다시 동의해야 함).
      await tx.delete(directoryEntries).where(eq(directoryEntries.spaceId, change.spaceId))
    }
    const payload = sanitizeNoticePayload('name_mode_applied', { fromMode: change.fromMode, toMode: change.toMode, effectiveAt: change.effectiveAt.toISOString() })
    if (!payload) throw new Error('name_mode_applied payload not allowed')
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into community_notices (user_id, space_id, kind, name_mode_change_id, payload, created_at)
      select sm.user_id, sm.space_id, 'name_mode_applied', ${change.id}, ${JSON.stringify(payload)}::jsonb, ${now.toISOString()}::timestamptz
      from space_memberships sm join users u on u.id = sm.user_id
      where sm.space_id = ${change.spaceId} and sm.status = 'active' and u.status = 'active'
      on conflict (name_mode_change_id, kind, user_id) where name_mode_change_id is not null do nothing
      returning id`)
    await tx.insert(auditEvents).values({
      actorId: null,
      action: 'community.name_mode_apply',
      targetType: 'community_space',
      targetId: change.spaceId,
      metadata: { changeId: change.id, from: change.fromMode, to: change.toMode, notified: inserted.length },
    })
    await emitApplied(tx, change.requestedBy, change.fromMode, change.toMode, options)
    return { changeId: change.id, spaceId: change.spaceId, notified: inserted.length }
  })
}

/** 분석 이벤트(웹 emitAnalytics와 같은 규칙: 허용 목록·수집 거부·active 계정·HMAC). 예약한 사람이 없으면(탈퇴 정리) 건너뜁니다. */
async function emitApplied(tx: DbExecutor, actorId: string | null, from: string, to: string, options: ApplyNameModeOptions): Promise<void> {
  const pepper = options.analyticsPepper
  if (!pepper || !actorId) return
  const checked = sanitizeAnalyticsProps('name_mode_applied', { from, to })
  if (!checked.ok) return
  const [user] = await tx.select({ optOut: users.analyticsOptOut, status: users.status }).from(users).where(eq(users.id, actorId)).limit(1)
  if (!user || user.optOut || user.status !== 'active') return
  await tx.insert(analyticsEvents).values({
    name: 'name_mode_applied',
    actorHash: hashSubject(pepper, actorId),
    hashKeyId: pepperKeyId(pepper),
    props: checked.props,
    occurredAt: options.now,
  })
}

/** 기한이 지난 예약을 오래된 것부터 적용합니다(주기 작업). 실패한 예약은 세고 다음 주기에 다시 시도합니다. */
export async function applyDueNameModeChanges(db: DbExecutor, options: ApplyNameModeOptions): Promise<TaskOutcome & { applied: AppliedChange[] }> {
  const due = await db
    .select({ id: nameModeChanges.id })
    .from(nameModeChanges)
    .where(and(eq(nameModeChanges.status, 'scheduled'), lte(nameModeChanges.effectiveAt, options.now)))
    .orderBy(asc(nameModeChanges.effectiveAt), asc(nameModeChanges.id))
    .limit(options.limit ?? 100)
  const applied: AppliedChange[] = []
  let failed = 0
  for (const { id } of due) {
    try {
      const result = await applyNameModeChange(db, id, options)
      if (result) applied.push(result)
    } catch (error) {
      failed++
      console.error(`[worker] name-mode apply failed: ${(error as Error).name}`)
    }
  }
  return { affected: applied.length, batches: due.length ? 1 : 0, failed, applied }
}
