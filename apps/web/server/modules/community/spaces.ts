/**
 * 커뮤니티 공간: 목록·찾기·상세·사용자 방 만들기·설정·보관 (C-02, PROOFU_EVOLUTION_PLAN §8.9.2–§8.9.4, SYSTEM_DESIGN §6.7·§8.1·§9.1, ADR 0019).
 *
 * - 모든 경로는 `/api/v1/community/**`(로그인 필수, `X-Robots-Tag: noindex, nofollow`)이며 `/api/v1/public`에는 없습니다.
 * - 상세는 canReadSpace면 게시판·권한까지, 아니면 canPreviewSpace일 때 소개(이름·소개·멤버 수·가입 방식)만, 둘 다 아니면 404.
 * - 사용자 방은 active 학교 인증이 하나라도 있어야 만들고, 학교를 연결하면 그 학교 인증이 있어야 합니다. 이름의 예약어(`공식`·`학생회` 등)는 422,
 *   정원은 2~300(그 이상은 300으로 만들고 요청값을 운영자 검토로 남김).
 * - 이름 표시 방식은 만들 때 정하고, 바꾸기는 C-03의 7일 예약(name-modes.ts)으로만 합니다(PATCH는 422 not_editable). 공식 페이지는 anonymous 고정.
 *   상세의 nameMode는 지금 효력이 있는 방식(effective_at이 지난 예약 포함), pendingNameModeChange는 아직 효력이 없는 예약입니다.
 */
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import {
  BOARD_KINDS,
  BOARD_TITLE_MAX,
  BOARD_WRITE_ROLES,
  JOIN_POLICIES,
  MAX_BOARDS_PER_ROOM,
  NAME_MODES,
  ROOM_BOARD_KINDS,
  SPACE_DESCRIPTION_MAX,
  SPACE_DISCOVERIES,
  type BoardTemplate,
  type NameMode,
  type SpaceKind,
  type SpaceMembershipStatus,
  type SpaceRole,
  canCreateRoom,
  canJoinSpace,
  canManageSpace,
  canModerate,
  canPreviewSpace,
  canReadSpace,
  canWriteBoard,
  checkRoomCapacity,
  checkSpaceName,
  defaultBoardsFor,
  defaultJoinPolicy,
  effectiveWriteRole,
  isOfficialKind,
  previewIncludesDescription,
} from '@peerchive/domain'
import {
  and,
  asc,
  boards,
  communitySpaces,
  eq,
  inArray,
  isNull,
  ne,
  or,
  schools,
  spaceInvitations,
  spaceMemberships,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, rateLimited, sqlState } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import { loadScheduledChange, nameModeNow } from './name-modes'
import { unreadNoticeCount } from './notices'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import {
  type LoadedSpace,
  type SpaceContext,
  loadReadableSpace,
  loadSpaceContext,
  loadSpacesWhere,
  loadViewer,
  membershipFacts,
  spaceFacts,
} from './access'
import type {
  BoardDto,
  MySpacesDto,
  SpaceDetailDto,
  SpacePermissionsDto,
  SpaceSummaryDto,
} from '../../../shared/types/api'

type BoardRow = typeof boards.$inferSelect

/** 사용자당 방 만들기 한도(하루 10개). 정원·이름 검사보다 뒤에서 셉니다. */
export const ROOM_CREATE_LIMIT = { limit: 10, windowMs: 24 * 60 * 60 * 1000 }

// ── DTO ──────────────────────────────────────────────────────────────────

/** 공간 id → active 멤버 수. */
export async function memberCounts(db: DbExecutor, spaceIds: string[]): Promise<Map<string, number>> {
  if (spaceIds.length === 0) return new Map()
  const rows = await db
    .select({ spaceId: spaceMemberships.spaceId, n: sql<number>`count(*)::int` })
    .from(spaceMemberships)
    .where(and(inArray(spaceMemberships.spaceId, spaceIds), eq(spaceMemberships.status, 'active')))
    .groupBy(spaceMemberships.spaceId)
  return new Map(rows.map((r) => [r.spaceId, r.n]))
}

export function toSpaceSummary(
  space: LoadedSpace,
  memberCount: number,
  membership: { role: SpaceRole; status: SpaceMembershipStatus } | null,
): SpaceSummaryDto {
  const official = isOfficialKind(space.row.kind)
  return {
    slug: space.row.slug,
    kind: space.row.kind,
    official,
    name: space.row.name,
    description: space.row.description,
    school: space.schoolId && space.schoolName ? { id: space.schoolId, name: space.schoolName } : null,
    departmentLabel: space.row.departmentLabel,
    nameMode: space.row.currentNameMode,
    discovery: space.row.discovery,
    joinPolicy: space.row.joinPolicy,
    status: space.row.status,
    memberCount: official ? null : memberCount,
    myMembership: membership && (membership.status === 'active' || membership.status === 'pending') ? { role: membership.role, status: membership.status } : null,
  }
}

function toBoardDto(board: BoardRow, ctx: SpaceContext): BoardDto {
  return {
    id: board.id,
    kind: board.kind,
    title: board.title,
    writeRole: board.writeRole,
    position: board.position,
    canWrite: canWriteBoard(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), { kind: board.kind, writeRole: board.writeRole }),
  }
}

export function permissionsFor(ctx: SpaceContext): SpacePermissionsDto {
  const m = membershipFacts(ctx.membership)
  const can = (action: Parameters<typeof canManageSpace>[3]) => canManageSpace(ctx.viewer, ctx.facts, m, action)
  return {
    manage: can('update_settings'),
    manageBoards: can('manage_boards'),
    reviewRequests: can('review_requests'),
    removeMembers: can('remove_members'),
    invite: can('invite'),
    changeRoles: can('change_roles'),
    archive: can('archive'),
    moderate: canModerate(ctx.viewer, ctx.facts, m),
    changeNameMode: can('change_name_mode'),
  }
}

const NO_PERMISSIONS: SpacePermissionsDto = {
  manage: false,
  manageBoards: false,
  reviewRequests: false,
  removeMembers: false,
  invite: false,
  changeRoles: false,
  archive: false,
  moderate: false,
  changeNameMode: false,
}

export async function loadBoards(db: DbExecutor, spaceId: string): Promise<BoardRow[]> {
  return db.select().from(boards).where(eq(boards.spaceId, spaceId)).orderBy(asc(boards.position), asc(boards.createdAt))
}

function joinActionFor(ctx: SpaceContext): SpaceDetailDto['joinAction'] {
  const decision = canJoinSpace(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), 'self')
  if (decision.ok) return decision.status === 'active' ? 'join' : 'request'
  return decision.reason === 'already_pending' ? 'pending' : 'none'
}

/**
 * 상세 DTO. preview(멤버가 아닌 사람의 소개, C-05·ADR 0021)는 이름·멤버 수·가입 방식·이름 표시 방식만 싣습니다:
 * 게시판·권한·멤버 목록 없음, 정원 검토 요청값 없음, unlisted 방은 소개 글도 없음(`previewIncludesDescription`).
 * 초대 전용 방은 preview 자체가 없습니다(canPreviewSpace → 404).
 */
async function detailFor(db: DbExecutor, ctx: SpaceContext, access: 'member' | 'preview', now: Date): Promise<SpaceDetailDto> {
  const official = isOfficialKind(ctx.space.row.kind)
  const boardRows = access === 'member' ? await loadBoards(db, ctx.space.row.id) : []
  const { mode, pending } = nameModeNow(ctx.space.row.currentNameMode, official ? null : await loadScheduledChange(db, ctx.space.row.id), now)
  const summary = toSpaceSummary(ctx.space, ctx.facts.activeMembers, ctx.membership)
  return {
    ...summary,
    description: access === 'member' || previewIncludesDescription(ctx.facts) ? summary.description : null,
    nameMode: mode,
    pendingNameModeChange: pending,
    access,
    boards: boardRows.map((b) => toBoardDto(b, ctx)),
    permissions: access === 'member' ? permissionsFor(ctx) : NO_PERMISSIONS,
    joinAction: joinActionFor(ctx),
    capacity: official ? null : ctx.space.row.capacity,
    capacityRequested: official || access === 'preview' ? null : ctx.space.row.capacityRequested,
    createdAt: ctx.space.row.createdAt.toISOString(),
  }
}

// ── 읽기 ─────────────────────────────────────────────────────────────────

/** 사람이 볼 수 있는 공식 페이지 조건: 내 정본 학교들의 공식 페이지. */
function officialForSchools(schoolIds: string[]) {
  if (schoolIds.length === 0) return sql`false`
  return and(
    inArray(communitySpaces.kind, ['official_school', 'official_department']),
    inArray(sql`coalesce(${schools.mergedInto}, ${schools.id})`, schoolIds),
  )
}

/** GET /community/spaces/mine — 내가 active 멤버인 방 + 내 학교의 공식 페이지 + 승인 대기. */
export async function listMySpaces(db: DbExecutor, actor: Actor): Promise<MySpacesDto> {
  const viewer = await loadViewer(db, actor)
  const schoolIds = viewer.affiliations.map((a) => a.schoolId)
  const myRows = await db
    .select({ spaceId: spaceMemberships.spaceId, role: spaceMemberships.role, status: spaceMemberships.status })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.userId, actor.userId), inArray(spaceMemberships.status, ['active', 'pending'])))
  const mine = new Map(myRows.map((r) => [r.spaceId, r]))
  const spaces = await loadSpacesWhere(
    db,
    and(
      or(
        myRows.length ? and(inArray(communitySpaces.id, [...mine.keys()]), inArray(communitySpaces.kind, ['user_room', 'study_room'])) : sql`false`,
        viewer.status === 'active' ? officialForSchools(schoolIds) : sql`false`,
      ),
    ),
  )
  const counts = await memberCounts(db, spaces.map((s) => s.row.id))
  const items: SpaceSummaryDto[] = []
  const pending: SpaceSummaryDto[] = []
  for (const s of sortSpaces(spaces)) {
    const m = mine.get(s.row.id) ?? null
    const count = counts.get(s.row.id) ?? 0
    // 상세와 같은 정책 함수로 거릅니다(C-05): 학교 인증이 해제된 학교 연결 방, 초대 전용으로 바뀐 방의 승인 대기는 목록에도 없습니다.
    const facts = spaceFacts(s, count)
    const isPending = !isOfficialKind(s.row.kind) && m?.status === 'pending'
    const mf = m ? { role: m.role, status: m.status } : null
    if (isPending ? !canPreviewSpace(viewer, facts, mf) : !canReadSpace(viewer, facts, mf)) continue
    const dto = toSpaceSummary(s, count, m)
    if (isPending) pending.push({ ...dto, description: previewIncludesDescription(facts) ? dto.description : null })
    else items.push(dto)
  }
  return { items, pending, canCreateRoom: canCreateRoom(viewer, null), schools: viewer.schools, unreadNotices: await unreadNoticeCount(db, actor.userId) }
}

/** 공식 페이지 먼저, 그 안에서 학교 페이지 → 학과 페이지, 나머지는 최근 것부터. */
function sortSpaces(list: LoadedSpace[]): LoadedSpace[] {
  const rank = (k: SpaceKind) => (k === 'official_school' ? 0 : k === 'official_department' ? 1 : 2)
  return [...list].sort((a, b) => rank(a.row.kind) - rank(b.row.kind) || b.row.createdAt.getTime() - a.row.createdAt.getTime() || (a.row.id < b.row.id ? -1 : 1))
}

const discoverSchema = z.object({ q: z.string({ error: 'invalid' }).trim().max(40, { error: 'too_long' }).optional() })

/**
 * GET /community/spaces/discover?q= — 내 학교의 공식 페이지 + 목록에 노출된(listed) active 사용자 방 중 내가 들어갈 수 있는 것
 * (학교 연결 방은 그 학교 인증, 학교 무관 방은 아무 학교 인증). 초대 전용·내보내진 방은 빼고, 최대 50개.
 */
export async function discoverSpaces(db: DbExecutor, actor: Actor, query: unknown): Promise<SpaceSummaryDto[]> {
  const { q } = parseInput(discoverSchema, query)
  const viewer = await loadViewer(db, actor)
  if (viewer.status !== 'active' || viewer.affiliations.length === 0) return []
  const schoolIds = viewer.affiliations.map((a) => a.schoolId)
  const nameFilter = q ? sql`${communitySpaces.name} ilike ${'%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}` : undefined
  const rows = await loadSpacesWhere(
    db,
    and(
      eq(communitySpaces.status, 'active'),
      nameFilter,
      or(
        officialForSchools(schoolIds),
        and(
          eq(communitySpaces.kind, 'user_room'),
          eq(communitySpaces.discovery, 'listed'),
          ne(communitySpaces.joinPolicy, 'invite'),
          or(isNull(communitySpaces.schoolId), inArray(sql`coalesce(${schools.mergedInto}, ${schools.id})`, schoolIds)),
        ),
      ),
    ),
  )
  const ids = rows.map((r) => r.row.id)
  const myRows = ids.length
    ? await db
        .select({ spaceId: spaceMemberships.spaceId, role: spaceMemberships.role, status: spaceMemberships.status })
        .from(spaceMemberships)
        .where(and(eq(spaceMemberships.userId, actor.userId), inArray(spaceMemberships.spaceId, ids)))
    : []
  const mine = new Map(myRows.map((r) => [r.spaceId, r]))
  const counts = await memberCounts(db, ids)
  return sortSpaces(rows)
    .filter((s) => mine.get(s.row.id)?.status !== 'removed')
    .slice(0, 50)
    .map((s) => toSpaceSummary(s, counts.get(s.row.id) ?? 0, mine.get(s.row.id) ?? null))
}

/** GET /community/spaces/:slug — 읽을 수 있으면 게시판까지, 소개만 볼 수 있으면 preview, 아니면 404. */
export async function getSpaceDetail(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<SpaceDetailDto> {
  const ctx = await loadSpaceContext(db, actor, ref)
  const m = membershipFacts(ctx.membership)
  if (canReadSpace(ctx.viewer, ctx.facts, m)) return detailFor(db, ctx, 'member', now)
  if (canPreviewSpace(ctx.viewer, ctx.facts, m)) return detailFor(db, ctx, 'preview', now)
  throw notFound()
}

// ── 만들기 ───────────────────────────────────────────────────────────────

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** CSPRNG 무작위 slug(소문자·숫자 10자). */
export function generateSpaceSlug(): string {
  let out = ''
  for (let i = 0; i < 10; i++) out += SLUG_ALPHABET[randomInt(0, SLUG_ALPHABET.length)]
  return out
}

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const descriptionSchema = z
  .string({ error: 'invalid' })
  .trim()
  .max(SPACE_DESCRIPTION_MAX, { error: 'too_long' })
  .nullish()
  .transform((v) => (v ? v.normalize('NFC') : null))

export const createRoomSchema = z.object({
  name: z.unknown(),
  description: descriptionSchema,
  schoolId: z.uuid({ error: 'invalid' }).nullish(),
  nameMode: z.enum(NAME_MODES, { error: requiredOr('invalid') }),
  discovery: z.enum(SPACE_DISCOVERIES, { error: 'invalid' }).optional(),
  joinPolicy: z.enum(JOIN_POLICIES, { error: 'invalid' }).optional(),
  capacity: z.unknown().optional(),
})

export interface NewSpaceInput {
  kind: SpaceKind
  schoolId: string | null
  departmentLabel?: string | null
  departmentKey?: string | null
  name: string
  description: string | null
  nameMode: NameMode
  discovery: 'listed' | 'unlisted'
  joinPolicy: 'open' | 'approval' | 'invite'
  capacity: number
  capacityRequested: number | null
  createdBy: string
  /** 방장으로 넣을 사람(사용자 방·스터디 방). 공식 페이지는 null. */
  ownerId: string | null
  boards?: readonly BoardTemplate[]
}

/** 공간 행 + (있으면) owner 멤버십 + 기본 게시판. slug가 겹치면 다시 만듭니다(savepoint). 호출자의 트랜잭션 안에서 부릅니다. */
export async function insertSpace(tx: DbExecutor, input: NewSpaceInput, now: Date): Promise<typeof communitySpaces.$inferSelect> {
  let space: typeof communitySpaces.$inferSelect | undefined
  for (let attempt = 0; attempt < 5 && !space; attempt++) {
    try {
      space = await tx.transaction(async (sp) => {
        const [row] = await sp
          .insert(communitySpaces)
          .values({
            kind: input.kind,
            schoolId: input.schoolId,
            departmentLabel: input.departmentLabel ?? null,
            departmentKey: input.departmentKey ?? null,
            name: input.name,
            description: input.description,
            slug: generateSpaceSlug(),
            currentNameMode: input.nameMode,
            discovery: input.discovery,
            joinPolicy: input.joinPolicy,
            capacity: input.capacity,
            capacityRequested: input.capacityRequested,
            createdBy: input.createdBy,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        return row!
      })
    } catch (error) {
      if (sqlState(error) !== '23505' || !String((error as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? (error as { constraint_name?: string }).constraint_name ?? '').includes('slug')) {
        throw error
      }
    }
  }
  if (!space) throw new Error('could not allocate a space slug')
  if (input.ownerId) {
    await tx.insert(spaceMemberships).values({ spaceId: space.id, userId: input.ownerId, role: 'owner', status: 'active', joinedAt: now, createdAt: now, updatedAt: now })
  }
  const templates = input.boards ?? defaultBoardsFor(input.kind)
  if (templates.length) {
    await tx.insert(boards).values(
      templates.map((b, position) => ({
        spaceId: space!.id,
        kind: b.kind,
        title: b.title,
        writeRole: effectiveWriteRole(b.kind, b.writeRole),
        position,
        createdAt: now,
        updatedAt: now,
      })),
    )
  }
  return space
}

/** 사람이 고른 학교(병합된 id도 됨)를 정본으로. 없으면 404. */
async function canonicalSchoolId(db: DbExecutor, schoolId: string): Promise<string> {
  const [row] = await db
    .select({ id: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
    .from(schools)
    .where(eq(schools.id, schoolId.toLowerCase()))
    .limit(1)
  if (!row) throw notFound()
  return row.id
}

function nameOrThrow(raw: unknown, reserved: boolean): string {
  const checked = checkSpaceName(raw, { reserved })
  if (!checked.ok) throw invalid({ name: checked.reason })
  return checked.value
}

function capacityOrThrow(raw: unknown): { capacity: number; requested: number | null } {
  const checked = checkRoomCapacity(raw)
  if (!checked.ok) throw invalid({ capacity: checked.reason })
  return { capacity: checked.capacity, requested: checked.requested }
}

/**
 * POST /community/spaces — 사용자 방 만들기. 201 + 상세. 403 `affiliation_required`(active 학교 인증 없음·연결한 학교 인증 없음),
 * 404(없는 학교), 422(`name: required|too_long|reserved|invalid`, `capacity`, `nameMode`…), 429(하루 10개).
 */
export async function createRoom(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<SpaceDetailDto> {
  const input = parseInput(createRoomSchema, rawInput)
  const name = nameOrThrow(input.name, true)
  const { capacity, requested } = capacityOrThrow(input.capacity)
  const viewer = await loadViewer(db, actor)
  const schoolId = input.schoolId ? await canonicalSchoolId(db, input.schoolId) : null
  if (!canCreateRoom(viewer, schoolId)) throw new ServiceError('FORBIDDEN', 'affiliation_required', undefined, { requirement: 'school_affiliation', schoolId })
  if (!(await hitRateLimit(db, 'community_room_create', actor.userId, ROOM_CREATE_LIMIT, now))) throw rateLimited()
  const space = await db.transaction(async (tx) => {
    const row = await insertSpace(
      tx,
      {
        kind: 'user_room',
        schoolId,
        name,
        description: input.description,
        nameMode: input.nameMode,
        discovery: input.discovery ?? 'listed',
        joinPolicy: input.joinPolicy ?? defaultJoinPolicy(input.nameMode),
        capacity,
        capacityRequested: requested,
        createdBy: actor.userId,
        ownerId: actor.userId,
      },
      now,
    )
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.space_create',
      targetType: 'community_space',
      targetId: row.id,
      metadata: { kind: row.kind, schoolLinked: schoolId !== null, nameMode: row.currentNameMode, joinPolicy: row.joinPolicy, capacityRequested: requested },
    })
    await emitAnalytics(tx, { name: 'space_created', actorId: actor.userId, props: { kind: 'user_room' }, now })
    return row
  })
  return getSpaceDetail(db, actor, space.slug)
}

export interface StudyRoomInput {
  ownerId: string
  name: string
  schoolId: string | null
  nameMode?: NameMode
  linkedCourseId?: string | null
}

/**
 * 스터디 방 만들기(내부 전용, C-07 모집 마감이 부릅니다). 공개 API 경로는 없습니다. 호출자의 트랜잭션 안에서 부르고,
 * owner는 사용자 방과 같은 자격(active 학교 인증, 학교 연결 시 그 학교)이 있어야 합니다. 초대 전용·목록 비노출·표시명 기본(§8.9.5).
 * 지원자 초대는 C-07이 space_invitations 또는 멤버십으로 합니다.
 */
export async function createStudyRoomInternal(tx: DbExecutor, input: StudyRoomInput, now = new Date()): Promise<typeof communitySpaces.$inferSelect> {
  const viewer = await loadViewer(tx, { userId: input.ownerId })
  const schoolId = input.schoolId ? await canonicalSchoolId(tx, input.schoolId) : null
  if (!canCreateRoom(viewer, schoolId)) throw new ServiceError('FORBIDDEN', 'affiliation_required')
  const name = nameOrThrow(input.name, true)
  const row = await insertSpace(
    tx,
    {
      kind: 'study_room',
      schoolId,
      name,
      description: null,
      nameMode: input.nameMode ?? 'display',
      discovery: 'unlisted',
      joinPolicy: 'invite',
      capacity: 300,
      capacityRequested: null,
      createdBy: input.ownerId,
      ownerId: input.ownerId,
    },
    now,
  )
  if (input.linkedCourseId) await tx.update(communitySpaces).set({ linkedCourseId: input.linkedCourseId }).where(eq(communitySpaces.id, row.id))
  await recordAudit(tx, { actorId: input.ownerId, action: 'community.space_create', targetType: 'community_space', targetId: row.id, metadata: { kind: 'study_room' } })
  await emitAnalytics(tx, { name: 'space_created', actorId: input.ownerId, props: { kind: 'study_room' }, now })
  return row
}

// ── 설정·보관 ────────────────────────────────────────────────────────────

export const updateSpaceSchema = z.object({
  name: z.unknown().optional(),
  description: descriptionSchema.optional(),
  discovery: z.enum(SPACE_DISCOVERIES, { error: 'invalid' }).optional(),
  joinPolicy: z.enum(JOIN_POLICIES, { error: 'invalid' }).optional(),
  nameMode: z.unknown().optional(),
})

/** 읽을 수 있는 공간인데 active가 아니면 409, 권한이 없으면 403. */
export function assertCanManage(ctx: SpaceContext, action: Parameters<typeof canManageSpace>[3]): void {
  if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
  if (!canManageSpace(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), action)) throw forbidden()
}

/**
 * PATCH /community/spaces/:slug {name?, description?, discovery?, joinPolicy?} — 사용자 방은 owner·admin, 공식 페이지는 운영자.
 * 이름 표시 방식은 여기서 바꿀 수 없습니다(422 `nameMode: not_editable`; 바꾸기는 POST …/name-mode-changes의 7일 예약, C-03). 공식 페이지는 가입 방식·찾기가 없습니다(422).
 */
export async function updateSpace(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<SpaceDetailDto> {
  const input = parseInput(updateSpaceSchema, rawInput)
  if (input.nameMode !== undefined) throw invalid({ nameMode: 'not_editable' })
  const slug = await db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'update_settings')
    const official = isOfficialKind(ctx.space.row.kind)
    if (official && (input.joinPolicy !== undefined || input.discovery !== undefined)) {
      throw invalid({ [input.joinPolicy !== undefined ? 'joinPolicy' : 'discovery']: 'not_editable' })
    }
    const name = input.name === undefined ? undefined : nameOrThrow(input.name, !official)
    const changes = {
      ...(name !== undefined && { name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.discovery !== undefined && { discovery: input.discovery }),
      ...(input.joinPolicy !== undefined && { joinPolicy: input.joinPolicy }),
    }
    if (Object.keys(changes).length === 0) return ctx.space.row.slug
    await tx.update(communitySpaces).set({ ...changes, updatedAt: now }).where(eq(communitySpaces.id, ctx.space.row.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.space_update',
      targetType: 'community_space',
      targetId: ctx.space.row.id,
      metadata: { name: name !== undefined, description: input.description !== undefined, discovery: input.discovery ?? null, joinPolicy: input.joinPolicy ?? null },
    })
    return ctx.space.row.slug
  })
  return getSpaceDetail(db, actor, slug)
}

/** 공간을 보관합니다(트랜잭션 안, 권한은 호출자가 확인). 대기 중 가입 요청은 거절(removed 아님, left)하고 열린 초대는 취소합니다. */
export async function archiveSpaceInTx(tx: DbExecutor, spaceId: string, now: Date): Promise<void> {
  await tx.update(communitySpaces).set({ status: 'archived', archivedAt: now, updatedAt: now }).where(eq(communitySpaces.id, spaceId))
  await tx
    .update(spaceMemberships)
    .set({ status: 'left', endedAt: now, updatedAt: now })
    .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.status, 'pending')))
  await tx
    .update(spaceInvitations)
    .set({ revokedAt: now })
    .where(and(eq(spaceInvitations.spaceId, spaceId), isNull(spaceInvitations.revokedAt), isNull(spaceInvitations.usedAt)))
}

/** POST /community/spaces/:slug/archive — 사용자 방은 owner, 공식 페이지는 운영자. 보관된 방은 멤버가 읽기만 합니다. */
export async function archiveSpace(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<SpaceDetailDto> {
  const slug = await db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'archive')
    await archiveSpaceInTx(tx, ctx.space.row.id, now)
    await recordAudit(tx, { actorId: actor.userId, action: 'community.space_archive', targetType: 'community_space', targetId: ctx.space.row.id, metadata: { kind: ctx.space.row.kind, cause: 'manager' } })
    return ctx.space.row.slug
  })
  return getSpaceDetail(db, actor, slug)
}

// ── 게시판 ───────────────────────────────────────────────────────────────

const boardTitle = z
  .string({ error: 'invalid' })
  .transform((v) => v.normalize('NFC').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, { error: 'required' }).max(BOARD_TITLE_MAX, { error: 'too_long' }))

export const createBoardSchema = z.object({
  kind: z.enum(BOARD_KINDS, { error: requiredOr('invalid') }),
  title: boardTitle,
  writeRole: z.enum(BOARD_WRITE_ROLES, { error: 'invalid' }).optional(),
})

export const updateBoardSchema = z.object({
  title: boardTitle.optional(),
  writeRole: z.enum(BOARD_WRITE_ROLES, { error: 'invalid' }).optional(),
  position: z.number({ error: 'invalid' }).int({ error: 'invalid' }).min(0, { error: 'invalid' }).max(100, { error: 'invalid' }).optional(),
})

/** GET /community/spaces/:slug/boards — 읽을 수 있는 사람만(404). */
export async function listBoards(db: DbExecutor, actor: Actor, ref: unknown): Promise<BoardDto[]> {
  const ctx = await loadReadableSpace(db, actor, ref)
  return (await loadBoards(db, ctx.space.row.id)).map((b) => toBoardDto(b, ctx))
}

/**
 * POST /community/spaces/:slug/boards {kind, title, writeRole?} — 사용자 방은 owner·admin(종류: general·free·question·info·recruiting·notice,
 * 최대 10개), 공식 페이지는 운영자. 201. 409 `title_taken`·`too_many_boards`. notice는 항상 moderator 쓰기.
 */
export async function createBoard(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<BoardDto> {
  const input = parseInput(createBoardSchema, rawInput)
  return db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true)
    assertCanManage(ctx, 'manage_boards')
    const official = isOfficialKind(ctx.space.row.kind)
    if (!official && !ROOM_BOARD_KINDS.includes(input.kind)) throw invalid({ kind: 'not_allowed' })
    const existing = await loadBoards(tx, ctx.space.row.id)
    if (!official && existing.length >= MAX_BOARDS_PER_ROOM) throw conflict('too_many_boards', { max: MAX_BOARDS_PER_ROOM })
    if (existing.some((b) => b.title === input.title)) throw conflict('title_taken')
    const [row] = await tx
      .insert(boards)
      .values({
        spaceId: ctx.space.row.id,
        kind: input.kind,
        title: input.title,
        writeRole: effectiveWriteRole(input.kind, input.writeRole ?? 'member'),
        position: existing.length,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.board_create', targetType: 'community_space', targetId: ctx.space.row.id, metadata: { boardId: row!.id, kind: row!.kind, writeRole: row!.writeRole } })
    return toBoardDto(row!, ctx)
  })
}

/** PATCH /community/boards/:id {title?, writeRole?, position?} — 만들기와 같은 권한. notice의 쓰기 역할은 바꿀 수 없음(moderator 고정). */
export async function updateBoard(db: DbExecutor, actor: Actor, boardId: unknown, rawInput: unknown, now = new Date()): Promise<BoardDto> {
  const input = parseInput(updateBoardSchema, rawInput)
  if (!isUuid(boardId)) throw notFound()
  return db.transaction(async (tx) => {
    const [board] = await tx.select().from(boards).where(eq(boards.id, boardId.toLowerCase())).limit(1)
    if (!board) throw notFound()
    const ctx = await loadReadableSpace(tx, actor, board.spaceId, true)
    assertCanManage(ctx, 'manage_boards')
    if (input.title !== undefined && input.title !== board.title) {
      const [taken] = await tx.select({ id: boards.id }).from(boards).where(and(eq(boards.spaceId, board.spaceId), eq(boards.title, input.title))).limit(1)
      if (taken) throw conflict('title_taken')
    }
    const writeRole = input.writeRole === undefined ? board.writeRole : effectiveWriteRole(board.kind, input.writeRole)
    const [row] = await tx
      .update(boards)
      .set({ ...(input.title !== undefined && { title: input.title }), writeRole, ...(input.position !== undefined && { position: input.position }), updatedAt: now })
      .where(eq(boards.id, board.id))
      .returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.board_update', targetType: 'community_space', targetId: ctx.space.row.id, metadata: { boardId: board.id, writeRole } })
    return toBoardDto(row!, ctx)
  })
}
