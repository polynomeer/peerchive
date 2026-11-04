/**
 * 동문회·OB 방의 멤버 명부 동의 (A-03, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 DirectoryEntry·§8.4, DELIVERY_PLAN §4.3·§5.3 X, ADR 0040).
 *
 * - 동의 철회를 뺀 모든 경로는 P2 `alumni` 플래그 뒤(requireFeature, 꺼져 있으면 404, 철회는 ADR 0060 D-02)이고 **alumni 템플릿 방의 active 멤버만**(loadAlumniRoom, 아니면 404 —
 *   운영자도 멤버가 아니면 404). 지금 효력이 있는 이름 표시 방식이 익명이면 보기·동의는 409 `directory_unavailable`(철회는 됨).
 * - **동의한 멤버만 행이 있습니다**(`PUT …/directory/me {consent: true, …}`). 항목은 모두 선택이고 각각 비울 수 있습니다.
 * - **철회(`DELETE …/directory/me`)·방 나가기·내보내기는 같은 트랜잭션에서 행을 바로 지웁니다**(deleteDirectoryEntryInTx). 탈퇴는 worker purge,
 *   익명 방 전환은 worker 이름 표시 방식 적용이 지웁니다. `withdrawn_at`은 두지 않습니다.
 * - **내보내기 경로가 없습니다**: 쪽 단위 조회(최대 20개)만 있고, 쪽을 볼 때마다 사용자별 rate limit(10분에 20쪽)을 셉니다. CSV·PDF·일괄 조회·
 *   “전부 가져오기” 값은 없고, 큰 쪽 크기나 모르는 조회 값은 422입니다.
 * - 이름은 방별 프로필 규칙(A-01, roomMemberNames): 실명 방은 실명, 표시명 방은 방별 이름. 응답에는 사람 id·핸들·계정 표시 이름·항목 id가 없습니다.
 * - 이 모듈은 커뮤니티 모듈 안에 있고 social 모듈·공개 경로·검색·추천은 이 표를 읽지 않습니다(S-02 경계 테스트가 확인).
 * - 감사 기록에는 새 동의 여부·채운 항목 수·철회 원인만(값 없음). 명부 조회는 남기지 않습니다.
 * - A-07(ADR 0045): 항목마다 신고용 `id`(동의마다 새 무작위 값)를 싣습니다. 운영 조치로 숨긴 항목(`hidden_at`)은 다른 멤버의 명부에서 빠지고
 *   본인에게는 `hidden: true`로 보입니다. 숨긴 동안에도 고치거나 철회할 수 있습니다(철회권 우선 — 행이 지워짐). 분석 `directory_consent_changed`.
 */
import { checkDirectoryEntryInput, directoryAvailable, filledDirectoryFields, parseDirectoryQuery } from '@peerchive/domain'
import { and, asc, directoryEntries, eq, isNull, spaceMemberships, users, type DbExecutor } from '@peerchive/db'
import { emitP2Analytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, rateLimited } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import { type AlumniRoom, assertRoomWritable, loadAlumniRoom, loadAlumniRoomMembership, roomMemberNames } from './alumni-room'
import type { DirectoryEntryDto, DirectoryPageDto, MyDirectoryEntryDto } from '../../../shared/types/api'

type EntryRow = typeof directoryEntries.$inferSelect

/** 명부 쪽 보기 한도(사용자별, 모든 방 합쳐 10분에 20쪽). 빠르게 넘기면 429 — 명부를 통째로 긁어 가지 못하게(§5.3 X). */
export const DIRECTORY_PAGE_VIEW_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 }
/** 명부 항목 저장 한도(사용자·시간당 30번). */
export const DIRECTORY_UPDATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 }

interface DirectoryRoom extends AlumniRoom {
  mode: 'real' | 'display'
}

/** 플래그 → 읽을 수 있는 공간 → active 멤버 → alumni 템플릿(아니면 404) → 익명이 아님(409 `directory_unavailable`). */
async function loadDirectoryRoom(db: DbExecutor, actor: Actor, ref: unknown, lock: boolean, now: Date): Promise<DirectoryRoom> {
  const room = await loadAlumniRoom(db, actor, ref, lock, now)
  if (!directoryAvailable('alumni', room.mode) || (room.mode !== 'real' && room.mode !== 'display')) throw conflict('directory_unavailable')
  return { ctx: room.ctx, mode: room.mode }
}

function toDto(row: EntryRow, name: string, viewerId: string): DirectoryEntryDto {
  return {
    id: row.id,
    name,
    cohortLabel: row.cohortLabel,
    currentWork: row.currentWork,
    interests: row.interests,
    contactMethod: row.contactMethod,
    mine: row.userId === viewerId,
    hidden: row.hiddenAt !== null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function myEntry(db: DbExecutor, room: DirectoryRoom, viewerId: string): Promise<DirectoryEntryDto | null> {
  const [row] = await db
    .select()
    .from(directoryEntries)
    .where(and(eq(directoryEntries.spaceId, room.ctx.space.row.id), eq(directoryEntries.userId, viewerId)))
    .limit(1)
  if (!row) return null
  const names = await roomMemberNames(db, room.ctx.space.row.id, room.mode, [viewerId])
  return toDto(row, names.get(viewerId)!, viewerId)
}

/**
 * GET /community/spaces/:slug/directory?page=&pageSize= — 방 멤버만. 동의한 active 멤버의 항목을 동의한 순서로 한 쪽(최대 20개)씩.
 * 404, 409 `directory_unavailable`, 422(`page`·`pageSize: invalid|too_large`, 그 밖의 값 `unknown`), 429(10분에 20쪽).
 * 전체 수는 돌려주지 않습니다(`hasNext`만).
 */
export async function listDirectory(db: DbExecutor, actor: Actor, ref: unknown, query: unknown, now = new Date()): Promise<DirectoryPageDto> {
  const room = await loadDirectoryRoom(db, actor, ref, false, now)
  const parsed = parseDirectoryQuery(query && typeof query === 'object' ? (query as Record<string, unknown>) : {})
  if (!parsed.ok) throw invalid(parsed.fields)
  // 트랜잭션 밖에서 셉니다(429로 끝나도 카운터가 남음).
  if (!(await hitRateLimit(db, 'directory_page_view', actor.userId, DIRECTORY_PAGE_VIEW_LIMIT, now))) throw rateLimited()
  const spaceId = room.ctx.space.row.id
  // 나간 사람의 행은 나갈 때 지워지지만, 혹시 남아 있어도 active 멤버·active 계정만 보입니다.
  const rows = await db
    .select({ entry: directoryEntries })
    .from(directoryEntries)
    .innerJoin(spaceMemberships, and(eq(spaceMemberships.spaceId, directoryEntries.spaceId), eq(spaceMemberships.userId, directoryEntries.userId)))
    .innerJoin(users, eq(users.id, directoryEntries.userId))
    .where(and(eq(directoryEntries.spaceId, spaceId), eq(spaceMemberships.status, 'active'), eq(users.status, 'active'), isNull(directoryEntries.hiddenAt)))
    .orderBy(asc(directoryEntries.consentedAt), asc(directoryEntries.userId))
    .offset((parsed.page - 1) * parsed.pageSize)
    .limit(parsed.pageSize + 1)
  const hasNext = rows.length > parsed.pageSize
  const pageRows = rows.slice(0, parsed.pageSize).map((r) => r.entry)
  const names = await roomMemberNames(db, spaceId, room.mode, pageRows.map((r) => r.userId))
  return {
    nameMode: room.mode,
    writable: room.ctx.space.row.status === 'active',
    page: parsed.page,
    pageSize: parsed.pageSize,
    hasNext,
    mine: await myEntry(db, room, actor.userId),
    entries: pageRows.map((r) => toDto(r, names.get(r.userId)!, actor.userId)),
  }
}

/**
 * PUT /community/spaces/:slug/directory/me {consent: true, cohortLabel?, currentWork?, interests?, contactMethod?} — 명부에 동의하고 항목을 정합니다
 * (전체 교체, 보내지 않거나 빈 항목은 비움). 처음이면 행을 만들고(consented_at), 있으면 바꿉니다.
 * 404, 409 `directory_unavailable`·`space_not_active`, 403 `write_restricted`, 422(`consent: required`, 항목별 `invalid|too_long|too_many`), 429.
 */
export async function putMyDirectoryEntry(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<MyDirectoryEntryDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const room = await loadDirectoryRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx)
    const checked = checkDirectoryEntryInput(raw)
    if (!checked.ok) throw invalid(checked.fields)
    if (!(await hitRateLimit(tx, 'directory_update', actor.userId, DIRECTORY_UPDATE_LIMIT, now))) throw rateLimited()
    const v = checked.value
    const spaceId = room.ctx.space.row.id
    const [existing] = await tx
      .select({ userId: directoryEntries.userId })
      .from(directoryEntries)
      .where(and(eq(directoryEntries.spaceId, spaceId), eq(directoryEntries.userId, actor.userId)))
      .limit(1)
      .for('update')
    const values = { cohortLabel: v.cohortLabel, currentWork: v.currentWork, interests: v.interests, contactMethod: v.contactMethod, updatedAt: now }
    if (existing) {
      await tx
        .update(directoryEntries)
        .set(values)
        .where(and(eq(directoryEntries.spaceId, spaceId), eq(directoryEntries.userId, actor.userId)))
    } else {
      await tx.insert(directoryEntries).values({ spaceId, userId: actor.userId, ...values, consentedAt: now })
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.directory_consent',
      targetType: 'community_space',
      targetId: spaceId,
      metadata: { created: !existing, filled: filledDirectoryFields(v) },
    })
    // A-07(§6.2 directory_consent_changed): 처음 동의할 때만(항목 바꾸기는 세지 않음). 채운 항목 수만.
    if (!existing) await emitP2Analytics(tx, { name: 'directory_consent_changed', actorId: actor.userId, props: { consented: true, filled: filledDirectoryFields(v) }, now })
    return { entry: await myEntry(tx, room, actor.userId) }
  })
}

/**
 * DELETE /community/spaces/:slug/directory/me — 동의 철회: 내 명부 행을 바로 지웁니다. 없으면 그대로(멱등).
 * 보관된 방·익명 방에서도, 쓰기 제한 중에도, 플래그가 꺼져 있어도 됩니다(ADR 0060 D-02). 멤버 아님·alumni 아님은 404.
 */
export async function withdrawMyDirectoryEntry(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<MyDirectoryEntryDto & { withdrawn: boolean }> {
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoomMembership(tx, actor, ref, true, now)
    const withdrawn = await deleteDirectoryEntryInTx(tx, room.ctx.space.row.id, actor.userId)
    if (withdrawn) {
      await recordAudit(tx, { actorId: actor.userId, action: 'community.directory_withdraw', targetType: 'community_space', targetId: room.ctx.space.row.id, metadata: { cause: 'self' } })
      await emitP2Analytics(tx, { name: 'directory_consent_changed', actorId: actor.userId, props: { consented: false }, now })
    }
    return { entry: null, withdrawn }
  })
}

/** 내 명부 행이 있는지(값은 읽지 않음). 플래그가 꺼진 방의 공간 상세가 철회 버튼을 보여 줄 때 씁니다(ADR 0060 D-02). */
export async function hasDirectoryEntry(db: DbExecutor, spaceId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: directoryEntries.userId })
    .from(directoryEntries)
    .where(and(eq(directoryEntries.spaceId, spaceId), eq(directoryEntries.userId, userId)))
    .limit(1)
  return !!row
}

/** 방을 나가거나 내보내질 때(같은 트랜잭션, 플래그와 무관하게)·철회할 때: 그 사람의 그 방 명부 행을 지웁니다. 지운 행이 있으면 true. */
export async function deleteDirectoryEntryInTx(tx: DbExecutor, spaceId: string, userId: string): Promise<boolean> {
  const removed = await tx
    .delete(directoryEntries)
    .where(and(eq(directoryEntries.spaceId, spaceId), eq(directoryEntries.userId, userId)))
    .returning({ userId: directoryEntries.userId })
  return removed.length > 0
}
