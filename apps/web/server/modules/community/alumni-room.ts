/**
 * 동문회·OB 방 모임 도구(A-02, ADR 0039)의 공통 접근·이름·정리. 일정(room-events.ts)·공지 읽음(notice-reads.ts)·투표(room-polls.ts)·
 * 앨범(room-album.ts)이 함께 씁니다.
 *
 * - 모든 경로는 P2 `alumni` 플래그 뒤(requireFeature, 꺼져 있으면 404)이고, **alumni 템플릿 방의 active 멤버만**(아니면 404 — 운영자도 멤버가
 *   아니면 404). 방별 프로필(A-01)과 달리 익명 방에서도 씁니다(응답자 이름만 숨김).
 * - 응답에는 사람 id·핸들·계정 표시 이름이 없습니다. 응답자 이름은 방별 프로필 이름 규칙(A-01)만 씁니다.
 * - 방을 나가거나 내보내지면 같은 트랜잭션에서 그 사람의 참석 응답·공지 읽음·투표 표를 지웁니다(deleteGatheringDataInTx).
 *   앨범 사진은 방의 기록이라 남깁니다(SYSTEM_DESIGN §6.7.2). 탈퇴는 worker purge가 사진·파일까지 지웁니다.
 * - 이 모듈들은 커뮤니티 모듈 안에 있고 social 모듈·공개 경로는 import하지 않습니다(S-02 경계 테스트가 확인).
 */
import { REAL_NAME_MISSING_LABEL, ROOM_PROFILE_NAME_MISSING_LABEL, type NameMode } from '@peerchive/domain'
import { and, eq, inArray, isNull, noticeReads, roomEventRsvps, roomEvents, roomPollVotes, roomPolls, roomProfiles, sql, users, type DbExecutor } from '@peerchive/db'
import { type Actor, conflict, notFound } from '../errors'
import { requireFeature } from '../features'
import { type SpaceContext, loadReadableSpace, writeRestricted } from './access'
import { loadScheduledChange, nameModeNow } from './name-modes'

export interface AlumniRoom {
  ctx: SpaceContext
  /** 지금 효력이 있는 이름 표시 방식(익명이면 응답자 이름을 숨김). */
  mode: NameMode
}

/** 플래그 → 읽을 수 있는 공간 → active 멤버 → alumni 템플릿. 아니면 404. */
export async function loadAlumniRoom(db: DbExecutor, actor: Actor, ref: unknown, lock: boolean, now: Date): Promise<AlumniRoom> {
  requireFeature('alumni')
  return loadAlumniRoomMembership(db, actor, ref, lock, now)
}

/** 플래그를 보지 않는 loadAlumniRoom: 동의 철회처럼 기능 개방과 무관해야 하는 경로만 씁니다(ADR 0060 D-02). 멤버 확인은 같습니다. */
export async function loadAlumniRoomMembership(db: DbExecutor, actor: Actor, ref: unknown, lock: boolean, now: Date): Promise<AlumniRoom> {
  const ctx = await loadReadableSpace(db, actor, ref, lock, now)
  if (ctx.space.row.template !== 'alumni' || ctx.space.row.kind !== 'user_room') throw notFound()
  if (ctx.membership?.status !== 'active') throw notFound()
  const { mode } = nameModeNow(ctx.space.row.currentNameMode, await loadScheduledChange(db, ctx.space.row.id), now)
  return { ctx, mode }
}

/** 쓰기(응답·투표·사진 올리기 등): 보관·제한된 방 409 `space_not_active`, 이용 제한 중 403 `write_restricted`. */
export function assertRoomWritable(ctx: SpaceContext, options: { restricted?: boolean } = {}): void {
  if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
  if (options.restricted !== false && ctx.viewer.writeRestriction) throw writeRestricted(ctx.viewer.writeRestriction)
}

/**
 * 방 안에서 보이는 이름(응답자 목록): 실명 방은 실명(A-01 방별 프로필과 같은 규칙), 표시명 방은 방별 프로필 이름(없으면 `방별 이름 없음`).
 * 익명 방은 이름을 돌려주지 않습니다(호출자가 개수만 보여 줌). 표시명 페르소나·계정 표시 이름·핸들은 읽지 않습니다.
 */
export async function roomMemberNames(db: DbExecutor, spaceId: string, mode: NameMode, userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)]
  if (mode === 'anonymous' || ids.length === 0) return new Map()
  if (mode === 'real') {
    const rows = await db.select({ id: users.id, realName: users.realName }).from(users).where(inArray(users.id, ids))
    return new Map(rows.map((r) => [r.id, r.realName?.trim() || REAL_NAME_MISSING_LABEL]))
  }
  // A-07: 운영 조치로 숨긴 방별 프로필은 없는 것처럼(`방별 이름 없음`).
  const rows = await db
    .select({ userId: roomProfiles.userId, displayName: roomProfiles.displayName })
    .from(roomProfiles)
    .where(and(eq(roomProfiles.spaceId, spaceId), inArray(roomProfiles.userId, ids), isNull(roomProfiles.hiddenAt)))
  const named = new Map(rows.map((r) => [r.userId, r.displayName ?? ROOM_PROFILE_NAME_MISSING_LABEL]))
  return new Map(ids.map((id) => [id, named.get(id) ?? ROOM_PROFILE_NAME_MISSING_LABEL]))
}

export interface GatheringDeletion {
  rsvps: number
  noticeReads: number
  pollVotes: number
}

/**
 * 방을 나가거나 내보내질 때(같은 트랜잭션, 플래그와 무관하게): 그 사람의 그 방 참석 응답·공지 읽음·투표 표를 지웁니다.
 * 읽음 수·투표 집계는 그만큼 줄어듭니다(마감한 투표 포함, ADR 0039). 그 사람이 만든 일정·투표와 올린 앨범 사진은 방의 기록이라 남깁니다.
 */
export async function deleteGatheringDataInTx(tx: DbExecutor, spaceId: string, userId: string): Promise<GatheringDeletion> {
  const rsvps = await tx
    .delete(roomEventRsvps)
    .where(and(eq(roomEventRsvps.userId, userId), inArray(roomEventRsvps.eventId, tx.select({ id: roomEvents.id }).from(roomEvents).where(eq(roomEvents.spaceId, spaceId)))))
    .returning({ id: roomEventRsvps.eventId })
  const reads = await tx
    .delete(noticeReads)
    .where(and(eq(noticeReads.userId, userId), eq(noticeReads.spaceId, spaceId)))
    .returning({ id: noticeReads.postId })
  const votes = await tx
    .delete(roomPollVotes)
    .where(and(eq(roomPollVotes.userId, userId), inArray(roomPollVotes.pollId, tx.select({ id: roomPolls.id }).from(roomPolls).where(eq(roomPolls.spaceId, spaceId)))))
    .returning({ id: roomPollVotes.pollId })
  return { rsvps: rsvps.length, noticeReads: reads.length, pollVotes: votes.length }
}

/** uuid 경로 값(대소문자 무시)인지. 아니면 404. */
export function uuidOr404(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw notFound()
  return value.toLowerCase()
}

export const countAll = sql<number>`count(*)::int`
