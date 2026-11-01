/**
 * 동문회·OB 방 항목의 신고·숨김 (A-07, DELIVERY_PLAN §4.3 A-07 "명부·일정·토픽 신고 사유", ADR 0045·0015·0039·0040).
 *
 * 신고·운영 조치 모듈(moderation)은 커뮤니티 테이블을 직접 읽지 않고 이 함수들을 부릅니다(community/reporting.ts가 다시 내보냄).
 * - 대상: 명부 항목(`directory_entry`)·일정(`event`)·투표(`poll`)·앨범 사진(`album_photo`)·방별 프로필(`room_profile`). 신고 값은
 *   `{spaceSlug, kind, itemId}`이고, **신고자가 그 방 active 멤버로 지금 보는 숨기지 않은 항목**만 신고할 수 있습니다(alumni 플래그 꺼짐·멤버 아님·
 *   alumni 방 아님·숨김·없음은 404 — 각 화면의 판정과 같음). 명부·방별 프로필은 익명 방에 없으므로 익명 방이면 404입니다.
 * - 신고·조치 행에는 종류 + 항목 id만 남고 **주인 사용자 id는 두지 않습니다**. 운영자 화면에는 방 멤버가 보는 값만 싣습니다: 명부·방별 프로필은
 *   방 멤버에게 보이는 이름(실명 방은 실명, 표시명 방은 방별 이름), 일정·투표·사진은 만든·올린 사람 없이 내용만(멤버 화면에도 없음).
 * - 조치 `hide_room_item`은 그 행의 `hidden_at`만 채웁니다(지우지 않음). 숨긴 항목은 다음 요청부터 다른 멤버의 화면·서명 URL에서 빠지고,
 *   명부·방별 프로필은 본인에게만 "운영 조치로 숨김"으로 보입니다. 되돌리면(이의제기·해제) `hidden_at = null`.
 * - 당사자(안내·이의제기): 명부 항목·방별 프로필은 그 사람, 일정·투표는 만든 사람, 사진은 올린 사람(탈퇴 정리로 비면 없음).
 * - 명부 철회·방 나가기·탈퇴 정리는 숨긴 행도 지웁니다(철회권이 우선, 개인정보). 조치 기록은 지워진 항목을 가리키고 운영 화면은 "찾을 수 없음"입니다.
 */
import { createHmac } from 'node:crypto'
import type { Readable } from 'node:stream'
import { ALBUM_PHOTO_URL_TTL_MS, REAL_NAME_MISSING_LABEL, ROOM_ITEM_KINDS, ROOM_PROFILE_NAME_MISSING_LABEL, type RoomItemKind, displayBadges, isSpaceSlug } from '@peerchive/domain'
import {
  and,
  communitySpaces,
  directoryEntries,
  eq,
  inArray,
  roomAlbumPhotos,
  roomEvents,
  roomPolls,
  roomProfiles,
  spaceMemberships,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { ObjectNotFoundError, isObjectKey, type ObjectStorage } from '@peerchive/files'
import { affiliationPepper } from '../affiliation/config'
import { requireOperator } from '../catalog/operators'
import { type Actor, conflict, invalid, notFound } from '../errors'
import { isUuid } from '../projects/access'
import { constantTimeEqualHex } from '../security/tokens'
import { loadSpace } from './access'
import { loadAlumniRoom, roomMemberNames } from './alumni-room'
import { loadScheduledChange, nameModeNow } from './name-modes'
import type { OperatorRoomItemDto } from '../../../shared/types/api'

export const ROOM_ITEM_LABELS: Readonly<Record<RoomItemKind, string>> = {
  directory_entry: '명부 항목',
  event: '일정',
  poll: '투표',
  album_photo: '앨범 사진',
  room_profile: '방별 프로필',
}

const OWNER_PAGES: Readonly<Record<RoomItemKind, string>> = {
  directory_entry: 'directory',
  event: 'gatherings',
  poll: 'gatherings',
  album_photo: 'gatherings',
  room_profile: 'room-profiles',
}

interface ItemFacts {
  spaceId: string
  ownerId: string | null
  hidden: boolean
}

/** 항목 행의 공간·주인·숨김(종류별 표). 없으면 null. lock이면 그 행을 잠급니다(조치 적용). */
async function loadItemFacts(db: DbExecutor, kind: RoomItemKind, id: string, lock = false): Promise<ItemFacts | null> {
  const facts = (row: { spaceId: string; ownerId: string | null; hiddenAt: Date | null } | undefined): ItemFacts | null =>
    row ? { spaceId: row.spaceId, ownerId: row.ownerId, hidden: row.hiddenAt !== null } : null
  switch (kind) {
    case 'directory_entry': {
      const q = db.select({ spaceId: directoryEntries.spaceId, ownerId: directoryEntries.userId, hiddenAt: directoryEntries.hiddenAt }).from(directoryEntries).where(eq(directoryEntries.id, id)).limit(1)
      return facts((lock ? await q.for('update') : await q)[0])
    }
    case 'room_profile': {
      const q = db.select({ spaceId: roomProfiles.spaceId, ownerId: roomProfiles.userId, hiddenAt: roomProfiles.hiddenAt }).from(roomProfiles).where(eq(roomProfiles.id, id)).limit(1)
      return facts((lock ? await q.for('update') : await q)[0])
    }
    case 'event': {
      const q = db.select({ spaceId: roomEvents.spaceId, ownerId: roomEvents.createdBy, hiddenAt: roomEvents.hiddenAt }).from(roomEvents).where(eq(roomEvents.id, id)).limit(1)
      return facts((lock ? await q.for('update') : await q)[0])
    }
    case 'poll': {
      const q = db.select({ spaceId: roomPolls.spaceId, ownerId: roomPolls.createdBy, hiddenAt: roomPolls.hiddenAt }).from(roomPolls).where(eq(roomPolls.id, id)).limit(1)
      return facts((lock ? await q.for('update') : await q)[0])
    }
    case 'album_photo': {
      const q = db
        .select({ spaceId: roomAlbumPhotos.spaceId, ownerId: roomAlbumPhotos.uploaderId, hiddenAt: roomAlbumPhotos.hiddenAt, scanStatus: roomAlbumPhotos.scanStatus })
        .from(roomAlbumPhotos)
        .where(eq(roomAlbumPhotos.id, id))
        .limit(1)
      const [row] = lock ? await q.for('update') : await q
      // 검사를 통과하지 않은 사진은 올린 사람 말고는 볼 수 없으므로 신고·조치 대상이 아닙니다(없는 것으로 봄).
      return row && row.scanStatus === 'clean' ? facts(row) : null
    }
  }
}

/** 명부 항목·방별 프로필의 주인이 지금 그 방 active 멤버이고 계정이 active인지(목록 화면과 같은 조건). */
async function ownerIsActiveMember(db: DbExecutor, spaceId: string, ownerId: string | null): Promise<boolean> {
  if (!ownerId) return false
  const [row] = await db
    .select({ id: spaceMemberships.userId })
    .from(spaceMemberships)
    .innerJoin(users, eq(users.id, spaceMemberships.userId))
    .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.userId, ownerId), eq(spaceMemberships.status, 'active'), eq(users.status, 'active')))
    .limit(1)
  return !!row
}

function parseRef(raw: unknown): { spaceSlug: string; kind: RoomItemKind; itemId: string } {
  const ref = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const fields: Record<string, string> = {}
  if (!isSpaceSlug(ref.spaceSlug)) fields['targetRef.spaceSlug'] = 'invalid'
  if (typeof ref.kind !== 'string' || !(ROOM_ITEM_KINDS as readonly string[]).includes(ref.kind)) fields['targetRef.kind'] = 'invalid'
  if (!isUuid(ref.itemId)) fields['targetRef.itemId'] = 'invalid'
  if (Object.keys(fields).length) throw invalid(fields)
  return { spaceSlug: ref.spaceSlug as string, kind: ref.kind as RoomItemKind, itemId: (ref.itemId as string).toLowerCase() }
}

/** 신고 값의 항목 종류만(사유 판정용, 형식이 틀리면 null — 형식 오류는 resolveReportableRoomItem이 422로 알림). */
export function roomItemKindOf(raw: unknown): RoomItemKind | null {
  const kind = (raw as { kind?: unknown } | null)?.kind
  return typeof kind === 'string' && (ROOM_ITEM_KINDS as readonly string[]).includes(kind) ? (kind as RoomItemKind) : null
}

/**
 * 신고 대상 `{spaceSlug, kind, itemId}` → 종류·항목 id. 신고자가 그 방 active 멤버이고(alumni 플래그·alumni 방) 항목이 그 방의 숨기지 않은 것이어야
 * 합니다. 명부 항목·방별 프로필은 익명 방이 아니고 주인이 active 멤버일 때만(목록과 같음). 아니면 404, 형식 오류 422.
 */
export async function resolveReportableRoomItem(db: DbExecutor, actor: Actor, rawRef: unknown, now: Date): Promise<{ kind: RoomItemKind; itemId: string }> {
  const ref = parseRef(rawRef)
  const room = await loadAlumniRoom(db, actor, ref.spaceSlug, false, now)
  const facts = await loadItemFacts(db, ref.kind, ref.itemId)
  if (!facts || facts.hidden || facts.spaceId !== room.ctx.space.row.id) throw notFound()
  if (ref.kind === 'directory_entry' || ref.kind === 'room_profile') {
    if (room.mode === 'anonymous' || !(await ownerIsActiveMember(db, facts.spaceId, facts.ownerId))) throw notFound()
  }
  return { kind: ref.kind, itemId: ref.itemId }
}

/** 조치 당사자: 명부 항목·방별 프로필의 주인, 일정·투표를 만든 사람, 사진을 올린 사람. */
export async function roomItemOwnerIds(db: DbExecutor, kind: RoomItemKind | null, id: string | null): Promise<string[]> {
  if (!kind || !id) return []
  const facts = await loadItemFacts(db, kind, id)
  return facts?.ownerId ? [facts.ownerId] : []
}

/** 대상 표시("일정 · 방 이름")와 당사자 화면 주소. 지워진 항목은 종류만, 주소 null. */
export async function roomItemLabels(
  db: DbExecutor,
  items: ReadonlyArray<{ kind: RoomItemKind; id: string }>,
): Promise<Map<string, { label: string; ownerPath: string | null }>> {
  const out = new Map<string, { label: string; ownerPath: string | null }>()
  if (items.length === 0) return out
  const spaceOf = new Map<string, string>()
  for (const kind of ROOM_ITEM_KINDS) {
    const ids = [...new Set(items.filter((i) => i.kind === kind).map((i) => i.id))]
    if (!ids.length) continue
    let rows: Array<{ id: string; spaceId: string }> = []
    if (kind === 'directory_entry') rows = await db.select({ id: directoryEntries.id, spaceId: directoryEntries.spaceId }).from(directoryEntries).where(inArray(directoryEntries.id, ids))
    if (kind === 'room_profile') rows = await db.select({ id: roomProfiles.id, spaceId: roomProfiles.spaceId }).from(roomProfiles).where(inArray(roomProfiles.id, ids))
    if (kind === 'event') rows = await db.select({ id: roomEvents.id, spaceId: roomEvents.spaceId }).from(roomEvents).where(inArray(roomEvents.id, ids))
    if (kind === 'poll') rows = await db.select({ id: roomPolls.id, spaceId: roomPolls.spaceId }).from(roomPolls).where(inArray(roomPolls.id, ids))
    if (kind === 'album_photo') rows = await db.select({ id: roomAlbumPhotos.id, spaceId: roomAlbumPhotos.spaceId }).from(roomAlbumPhotos).where(inArray(roomAlbumPhotos.id, ids))
    for (const r of rows) spaceOf.set(`${kind}:${r.id}`, r.spaceId)
  }
  const spaceIds = [...new Set(spaceOf.values())]
  const spaceRows = spaceIds.length ? await db.select({ id: communitySpaces.id, name: communitySpaces.name, slug: communitySpaces.slug }).from(communitySpaces).where(inArray(communitySpaces.id, spaceIds)) : []
  const spaces = new Map(spaceRows.map((r) => [r.id, r]))
  for (const item of items) {
    const space = spaces.get(spaceOf.get(`${item.kind}:${item.id}`) ?? '')
    out.set(`${item.kind}:${item.id}`, {
      label: space ? `${ROOM_ITEM_LABELS[item.kind]} · ${space.name}` : ROOM_ITEM_LABELS[item.kind],
      ownerPath: space ? `/community/${OWNER_PAGES[item.kind]}/${space.slug}` : null,
    })
  }
  return out
}

const fmt = (d: Date) => d.toISOString()

/** 운영자 신고 상세의 방 항목(숨긴 것 포함, 지금 행). 없으면 null. 만든·올린 사람은 싣지 않습니다. */
export async function operatorRoomItem(db: DbExecutor, kind: RoomItemKind, id: string, operatorId: string, now: Date): Promise<OperatorRoomItemDto | null> {
  const facts = await loadItemFacts(db, kind, id)
  if (!facts) return null
  let space
  try {
    space = await loadSpace(db, facts.spaceId)
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_FOUND') return null
    throw error
  }
  const { mode } = nameModeNow(space.row.currentNameMode, await loadScheduledChange(db, space.row.id), now)
  const base = { itemKind: kind, space: { name: space.row.name, slug: space.row.slug, nameMode: mode }, hidden: facts.hidden }
  const field = (label: string, value: string | null | undefined) => (value ? [{ label, value }] : [])
  switch (kind) {
    case 'directory_entry': {
      const [row] = await db.select().from(directoryEntries).where(eq(directoryEntries.id, id)).limit(1)
      if (!row) return null
      const names = mode === 'anonymous' ? new Map<string, string>() : await roomMemberNames(db, space.row.id, mode, [row.userId])
      return {
        ...base,
        name: names.get(row.userId) ?? null,
        fields: [
          ...field('기수', row.cohortLabel),
          ...field('지금 하는 일', row.currentWork),
          ...field('관심 분야', row.interests.join(', ')),
          ...field('연락 방법', row.contactMethod),
        ],
        photoUrl: null,
      }
    }
    case 'room_profile': {
      const [row] = await db.select({ profile: roomProfiles, realName: users.realName }).from(roomProfiles).innerJoin(users, eq(users.id, roomProfiles.userId)).where(eq(roomProfiles.id, id)).limit(1)
      if (!row) return null
      const name = mode === 'real' ? row.realName?.trim() || REAL_NAME_MISSING_LABEL : (row.profile.displayName ?? ROOM_PROFILE_NAME_MISSING_LABEL)
      return {
        ...base,
        name,
        fields: [
          ...field('배지', displayBadges(row.profile.badges, row.profile.cohortLabel).join(', ')),
          ...field('기수', row.profile.cohortLabel),
          ...field('소개', row.profile.bio),
        ],
        photoUrl: null,
      }
    }
    case 'event': {
      const [row] = await db.select().from(roomEvents).where(eq(roomEvents.id, id)).limit(1)
      if (!row) return null
      return {
        ...base,
        name: null,
        fields: [
          { label: '제목', value: row.title },
          ...field('설명', row.description),
          ...field('장소', row.locationText),
          { label: '시작', value: fmt(row.startsAt) },
          { label: '반복', value: row.recurrence },
          { label: '상태', value: row.status },
        ],
        photoUrl: null,
      }
    }
    case 'poll': {
      const [row] = await db.select().from(roomPolls).where(eq(roomPolls.id, id)).limit(1)
      if (!row) return null
      return {
        ...base,
        name: null,
        fields: [
          { label: '질문', value: row.question },
          { label: '선택지', value: row.options.join(' / ') },
          { label: '마감', value: fmt(row.closesAt) },
        ],
        photoUrl: null,
      }
    }
    case 'album_photo': {
      const [row] = await db.select().from(roomAlbumPhotos).where(eq(roomAlbumPhotos.id, id)).limit(1)
      if (!row) return null
      const servable = row.scanStatus === 'clean' && row.metadataStripped && !!row.mediaType && isObjectKey(row.objectKey)
      const exp = now.getTime() + ALBUM_PHOTO_URL_TTL_MS
      return {
        ...base,
        name: null,
        fields: [...field('설명', row.caption)],
        photoUrl: servable ? `/api/v1/operator/community/room-items/album-photos/${row.id}/file?exp=${exp}&sig=${operatorPhotoSignature(row.id, operatorId, exp)}` : null,
      }
    }
  }
}

/** 운영자용 사진 서명(멤버 서명과 다른 접두어 — 멤버 URL을 운영자 경로에, 운영자 URL을 멤버 경로에 쓸 수 없음). */
function operatorPhotoSignature(photoId: string, operatorId: string, expiresAtMs: number): string {
  return createHmac('sha256', affiliationPepper()).update(`album-photo-op:v1:${photoId.toLowerCase()}:${operatorId.toLowerCase()}:${expiresAtMs}`).digest('hex')
}

/**
 * GET /api/v1/operator/community/room-items/album-photos/:id/file?exp=&sig= — 운영자 세션 + 그 운영자에게 맞는 5분 서명 + 검사 통과일 때만(숨긴 사진 포함 —
 * 이의제기 판단용). 그 밖은 404. 신고된 사진 하나를 보는 경로이며 앨범 목록은 없습니다.
 */
export async function openOperatorAlbumPhoto(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  photoId: unknown,
  query: { exp?: unknown; sig?: unknown },
  now = new Date(),
): Promise<{ stream: Readable; mediaType: string; bytes: number }> {
  await requireOperator(db, actor)
  if (!isUuid(photoId)) throw notFound()
  const exp = typeof query.exp === 'string' && /^\d{1,16}$/.test(query.exp) ? Number(query.exp) : NaN
  const sig = typeof query.sig === 'string' && /^[0-9a-f]{64}$/.test(query.sig) ? query.sig : null
  if (!Number.isFinite(exp) || !sig || exp <= now.getTime() || exp > now.getTime() + ALBUM_PHOTO_URL_TTL_MS) throw notFound()
  if (!constantTimeEqualHex(sig, operatorPhotoSignature(photoId, actor.userId, exp))) throw notFound()
  const [row] = await db.select().from(roomAlbumPhotos).where(eq(roomAlbumPhotos.id, photoId.toLowerCase())).limit(1)
  if (!row || row.scanStatus !== 'clean' || !row.metadataStripped || !row.mediaType || !isObjectKey(row.objectKey)) throw notFound()
  try {
    return { stream: await storage.get(row.objectKey), mediaType: row.mediaType, bytes: row.byteSize }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw notFound()
    throw error
  }
}

/** 지금 숨기지 않았고 있는지(운영자 상세의 "지금 제공 중"). */
export async function roomItemVisible(db: DbExecutor, kind: RoomItemKind, id: string): Promise<boolean> {
  const facts = await loadItemFacts(db, kind, id)
  return !!facts && !facts.hidden
}

/** hide_room_item 적용(같은 트랜잭션): 행을 잠그고 숨김. 없으면 404, 이미 숨김 409 `target_not_public`. */
export async function hideRoomItemInTx(tx: DbExecutor, kind: RoomItemKind, id: string, now: Date): Promise<void> {
  const facts = await loadItemFacts(tx, kind, id, true)
  if (!facts) throw notFound()
  if (facts.hidden) throw conflict('target_not_public')
  await setHidden(tx, kind, id, now)
}

/** 되돌림: hidden_at = null(행이 지워졌으면 아무것도 하지 않음). */
export async function unhideRoomItemInTx(tx: DbExecutor, kind: RoomItemKind, id: string): Promise<void> {
  await setHidden(tx, kind, id, null)
}

async function setHidden(tx: DbExecutor, kind: RoomItemKind, id: string, at: Date | null): Promise<void> {
  switch (kind) {
    case 'directory_entry':
      await tx.update(directoryEntries).set({ hiddenAt: at }).where(eq(directoryEntries.id, id))
      return
    case 'room_profile':
      await tx.update(roomProfiles).set({ hiddenAt: at }).where(eq(roomProfiles.id, id))
      return
    case 'event':
      await tx.update(roomEvents).set({ hiddenAt: at }).where(eq(roomEvents.id, id))
      return
    case 'poll':
      await tx.update(roomPolls).set({ hiddenAt: at }).where(eq(roomPolls.id, id))
      return
    case 'album_photo':
      await tx.update(roomAlbumPhotos).set({ hiddenAt: at }).where(eq(roomAlbumPhotos.id, id))
      return
  }
}
