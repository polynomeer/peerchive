/**
 * 활동 목록·팔로우 피드·팔로우 추천 (S-05, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 PersonaActivity·§8.3·§9.2·§11.3,
 * DELIVERY_PLAN §4.2 S-05·§5.2 Q·S·T, ADR 0035).
 *
 * social 모듈입니다: 커뮤니티 글 테이블·커뮤니티 모듈을 import하지 않습니다(S-02 경계 테스트). 세 읽기 모두 `withSocialRole`로 social DB 역할에서
 * 실행하고, 읽는 것은 `persona_activities`·페르소나·프로필·팔로우·차단·뮤트·공개 범위(과제 목록 판정용 과제·학기·과목 열)와 카드 함수
 * `persona_activity_cards`뿐입니다.
 *
 * - **원천은 페르소나 활동만**: 0~1단계(익명) 글은 투영 경로가 없어(도메인 규칙 + DB 트리거) 여기 들어올 수 없습니다.
 * - **읽기 시점 재확인**(§11.3): 행을 고른 뒤 `persona_activity_cards`가 원본 상태(게시·동의·숨김·삭제·listed·작성 시점 페르소나)를 다시 보고,
 *   커뮤니티 글은 보는 사람이 그 공간을 읽을 수 있을 때만 카드를 줍니다. worker가 늦어 withdrawn_at이 비어 있어도 철회·숨김 항목은 빠집니다.
 * - **공개 범위·차단·뮤트**: 항목 종류마다 `canViewActivityKind`(posts·notes_and_studies는 공개 범위, cases는 공개 절차 + 비공개 계정은 팔로워만),
 *   차단(주인이 나를 차단해 이 페르소나가 숨겨짐 / 내가 바로 이 페르소나를 차단함 — 같은 사람의 다른 페르소나 차단으로는 거르지 않음: 그러면 두
 *   페르소나가 같은 사람임을 알려 주게 됨), 뮤트(피드에서만). 모두 요청마다 지금 행으로 판정하므로 다음 요청부터 반영됩니다(캐시 없음).
 * - **피드는 사용자 단위**: 내 모든 페르소나의 active 팔로우를 합친 피드입니다. 나에게만 보이는 응답이라 내 두 페르소나가 이어져 드러날 상대가 없습니다.
 *   순서는 @peerchive/domain `compareFeedKeys`(한국 시간 하루 단위로 기록 먼저, 그다음 최근 순) — 팔로워 수·공감 수는 쿼리에 없습니다.
 * - **추천**: 같은 과목(내 과제의 과목 ∩ 내가 볼 수 있는 상대의 과제 수행 목록), 같은 학교(실명 페르소나만, 상대가 학교 배지를 공개했을 때만 — 표시명
 *   페르소나의 소속이나 공개하지 않은 소속을 추천 결과로 알려 주지 않음), 관심 직무 교집합. 나·이미 팔로우(요청 포함)·내가 차단한 페르소나·나에게
 *   숨겨진 페르소나·뮤트한 페르소나는 빼고, 한 사람의 페르소나는 하나만 추천합니다. 비공개 계정도 기본 정보는 공개라 추천에 나올 수 있습니다.
 * - 알림("팔로우한 사람의 새 글"·"팔로우 요청")은 만들지 않습니다(ADR 0035: 앱 안 알림 장치가 커뮤니티 전용뿐이라 미룸).
 */
import { createHash } from 'node:crypto'
import {
  and,
  asc,
  blocks,
  courseTerms,
  courses,
  desc,
  eq,
  follows,
  inArray,
  institutionAffiliations,
  isNull,
  mutes,
  ne,
  personaActivities,
  personas,
  profiles,
  projectListings,
  projectMembers,
  projects,
  schools,
  sql,
  users,
  visibilitySettings,
  type DbExecutor,
  type SQL,
} from '@peerchive/db'
import {
  ACTIVITY_KINDS,
  ANONYMOUS_VIEWER,
  FEED_PAGE_SIZE,
  type FeedRankKey,
  type PersonaActivityItemKind,
  type PersonaViewer,
  type SuggestionCandidate,
  type SuggestionSignals,
  type VisibilityAudience,
  type VisibilityItemKind,
  canViewActivityKind,
  canViewPersona,
  canViewPersonaItem,
  decodeActivityCursor,
  decodeFeedCursor,
  encodeActivityCursor,
  encodeFeedCursor,
  feedRankKey,
  isActivityKind,
  listingBlock,
  rankSuggestions,
  suggestionReasons,
} from '@peerchive/domain'
import { activeAffiliationSchoolIds } from '../affiliation/affiliations'
import { type Actor, invalid, notFound } from '../errors'
import { withSocialRole } from './db-role'
import { personaDisplayName, resolvePublicPersona } from './personas'
import { counterpartVisible, notHiddenFrom } from './relations'
import { loadVisibility, personaViewerFor } from './visibility'
import type { ActivityItemDto, FeedDto, FollowPersonaDto, FollowSuggestionDto, FollowSuggestionsDto, ProfileActivityDto } from '../../../shared/types/api'

type PersonaRow = typeof personas.$inferSelect

// ── 카드(읽기 시점 재확인) ─────────────────────────────────────────────────

interface ActivityRow {
  id: string
  personaId: string
  sourceType: ActivityItemDto['source']
  sourceId: string
  itemKind: PersonaActivityItemKind
  createdAt: Date
}

interface Card {
  title: string | null
  body: string | null
  href: string | null
  context: string | null
}

const activityColumns = {
  id: personaActivities.id,
  personaId: personaActivities.personaId,
  sourceType: personaActivities.sourceType,
  sourceId: personaActivities.sourceId,
  itemKind: sql<PersonaActivityItemKind>`${personaActivities.itemKind}`,
  createdAt: personaActivities.createdAt,
}

/** 활동 id → 지금 보여도 되는 카드. 원본 상태·커뮤니티 공간 열람 판정은 DB 함수가 합니다(없으면 그 활동은 빠짐). */
async function loadCards(db: DbExecutor, viewerUserId: string | null, ids: string[]): Promise<Map<string, Card>> {
  if (ids.length === 0) return new Map()
  const idArray = sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`
  const rows = (await db.execute(
    sql`select activity_id, title, body, href, context from persona_activity_cards(${viewerUserId}::uuid, ${idArray})`,
  )) as unknown as Array<{ activity_id: string; title: string | null; body: string | null; href: string | null; context: string | null }>
  return new Map(rows.map((r) => [r.activity_id, { title: r.title, body: r.body, href: r.href, context: r.context }]))
}

function toItem(row: ActivityRow, card: Card, author: FollowPersonaDto, isOwner: boolean): ActivityItemDto {
  return {
    id: row.id,
    source: row.sourceType,
    kind: row.itemKind,
    createdAt: row.createdAt.toISOString(),
    title: card.title,
    body: card.body,
    href: card.href,
    context: card.context,
    author,
    ...(isOwner && row.sourceType === 'profile_post' && { profilePostId: row.sourceId }),
  }
}

/**
 * 페이지 채우기: `fetch(after, n)`로 순서대로 행을 가져와 카드가 있는 것만 남깁니다. 재확인에서 빠지는 행이 있어도 한 페이지를 채우도록 몇 번 더
 * 읽고(최대 5번), 마지막으로 **본 행**(남긴 것이 아니라)을 다음 cursor의 기준으로 씁니다.
 */
async function fillPage<C>(
  fetch: (after: C | null, n: number) => Promise<ActivityRow[]>,
  cardsFor: (rows: ActivityRow[]) => Promise<Map<string, Card>>,
  keyOf: (row: ActivityRow) => C,
  start: C | null,
  size: number,
): Promise<{ kept: Array<{ row: ActivityRow; card: Card }>; next: C | null }> {
  const kept: Array<{ row: ActivityRow; card: Card }> = []
  let after = start
  for (let round = 0; round < 5; round++) {
    const want = size - kept.length
    const rows = await fetch(after, want + 1)
    const page = rows.slice(0, want)
    const cards = await cardsFor(page)
    for (const row of page) {
      const card = cards.get(row.id)
      if (card) kept.push({ row, card })
    }
    if (rows.length <= want) return { kept, next: null }
    after = keyOf(page[page.length - 1]!)
    if (kept.length >= size) return { kept, next: after }
  }
  return { kept, next: after }
}

// ── 활동 목록 ─────────────────────────────────────────────────────────────

/** 이 사람이 볼 수 있는 활동 종류(요청한 종류가 있으면 그것만). */
function visibleKinds(
  persona: Pick<PersonaRow, 'status' | 'accountPrivacy'>,
  stored: Map<VisibilityItemKind, VisibilityAudience>,
  viewer: PersonaViewer,
): PersonaActivityItemKind[] {
  return ACTIVITY_KINDS.filter((k) => canViewActivityKind(persona, k, k === 'cases' ? null : (stored.get(k) ?? null), viewer))
}

/**
 * GET /profiles/:handle/activity?kind=&cursor= — 한 페르소나의 활동(최근 순). 없는·비공개 상태 handle·차단당함 404, 모르는 kind·cursor 422.
 * 보는 사람이 볼 수 없는 종류는 결과와 `kinds`에서 빠집니다(이유를 밝히지 않음). 뮤트는 활동 목록에 영향이 없습니다(피드·알림에서만).
 */
export async function getProfileActivity(
  db: DbExecutor,
  actor: Actor | null,
  rawHandle: unknown,
  query: { kind?: unknown; cursor?: unknown } = {},
): Promise<ProfileActivityDto> {
  const kindFilter = query.kind === undefined || query.kind === '' ? null : query.kind
  if (kindFilter !== null && !isActivityKind(kindFilter)) throw invalid({ kind: 'invalid' })
  const cursor = query.cursor === undefined || query.cursor === '' ? null : decodeActivityCursor(query.cursor)
  if (query.cursor !== undefined && query.cursor !== '' && !cursor) throw invalid({ cursor: 'invalid' })
  return withSocialRole(db, async (tx) => {
    const { persona, displayName } = await resolvePublicPersona(tx, rawHandle)
    const viewer = await personaViewerFor(tx, persona, actor)
    if (!canViewPersona(persona, viewer)) throw notFound()
    const kinds = visibleKinds(persona, await loadVisibility(tx, persona.id), viewer)
    const wanted = kindFilter ? kinds.filter((k) => k === kindFilter) : kinds
    if (wanted.length === 0) return { kinds, items: [], nextCursor: null }
    const author: FollowPersonaDto = { kind: persona.kind, handle: persona.handle, displayName }
    const fetch = (after: { at: number; id: string } | null, n: number) =>
      tx
        .select(activityColumns)
        .from(personaActivities)
        .where(
          and(
            eq(personaActivities.personaId, persona.id),
            isNull(personaActivities.withdrawnAt),
            inArray(personaActivities.itemKind, wanted),
            after
              ? sql`(${personaActivities.createdAt}, ${personaActivities.id}) < (${new Date(after.at).toISOString()}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(personaActivities.createdAt), desc(personaActivities.id))
        .limit(n) as Promise<ActivityRow[]>
    const { kept, next } = await fillPage(
      fetch,
      (rows) => loadCards(tx, actor?.userId ?? null, rows.map((r) => r.id)),
      (r) => ({ at: r.createdAt.getTime(), id: r.id }),
      cursor,
      FEED_PAGE_SIZE,
    )
    return {
      kinds,
      items: kept.map(({ row, card }) => toItem(row, card, author, viewer.isOwner)),
      nextCursor: next ? encodeActivityCursor({ createdAt: new Date(next.at), id: next.id }) : null,
    }
  })
}

// ── 팔로우 피드 ───────────────────────────────────────────────────────────

/** SQL: 피드 순서의 날·묶음(@peerchive/domain feedDay·feedBucket과 같은 식). */
const daySql = sql<number>`floor((extract(epoch from ${personaActivities.createdAt}) + 32400) / 86400)::int`
const bucketSql = sql<number>`(case when ${personaActivities.itemKind} = 'posts' then 1 else 0 end)`

function afterFeedKey(key: FeedRankKey): SQL {
  const at = sql`${new Date(key.at).toISOString()}::timestamptz`
  return sql`(${daySql} < ${key.day}
    or (${daySql} = ${key.day} and ${bucketSql} > ${key.bucket})
    or (${daySql} = ${key.day} and ${bucketSql} = ${key.bucket} and ${personaActivities.createdAt} < ${at})
    or (${daySql} = ${key.day} and ${bucketSql} = ${key.bucket} and ${personaActivities.createdAt} = ${at} and ${personaActivities.id} < ${key.id}::uuid))`
}

interface Followee {
  persona: PersonaRow
  accountName: string
}

/**
 * 내가(어느 페르소나로든) active로 팔로우하는 페르소나 중 지금 공개 상태이고, 나에게 차단으로 숨겨지지 않았고, 내가 바로 그 페르소나를 차단·뮤트하지
 * 않은 것. 뮤트는 피드에서만 빼므로 `includeMuted`로 고릅니다.
 */
async function myFollowees(db: DbExecutor, actor: Actor, includeMuted: boolean): Promise<Followee[]> {
  const rows = await db
    .selectDistinctOn([personas.id], { persona: personas, accountName: users.displayName })
    .from(follows)
    .innerJoin(personas, eq(personas.id, follows.followeePersonaId))
    .innerJoin(users, eq(users.id, personas.userId))
    .innerJoin(profiles, eq(profiles.personaId, personas.id))
    .where(
      and(
        eq(follows.followerUserId, actor.userId),
        eq(follows.status, 'active'),
        ne(personas.userId, actor.userId),
        counterpartVisible(),
        notHiddenFrom(follows.followeePersonaId, follows.followeeUserId, actor.userId),
        sql`not exists (select 1 from ${blocks} b where b.blocker_user_id = ${actor.userId} and b.blocked_persona_id = ${personas.id})`,
        includeMuted ? undefined : sql`not exists (select 1 from ${mutes} m where m.muter_user_id = ${actor.userId} and m.muted_persona_id = ${personas.id})`,
      ),
    )
    .orderBy(asc(personas.id))
  return rows
}

/** 여러 사용자의 active 학교 인증(정본 학교). */
async function schoolsByUser(db: DbExecutor, userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (userIds.length === 0) return out
  const rows = await db
    .select({ userId: institutionAffiliations.userId, schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(and(inArray(institutionAffiliations.userId, userIds), eq(institutionAffiliations.status, 'active')))
  for (const r of rows) out.set(r.userId, (out.get(r.userId) ?? new Set()).add(r.schoolId))
  return out
}

/** 여러 페르소나의 저장된 공개 범위. */
async function visibilityByPersona(db: DbExecutor, personaIds: string[]): Promise<Map<string, Map<VisibilityItemKind, VisibilityAudience>>> {
  const out = new Map<string, Map<VisibilityItemKind, VisibilityAudience>>()
  if (personaIds.length === 0) return out
  const rows = await db
    .select({ personaId: visibilitySettings.personaId, itemKind: visibilitySettings.itemKind, audience: visibilitySettings.audience })
    .from(visibilitySettings)
    .where(inArray(visibilitySettings.personaId, personaIds))
  for (const r of rows) out.set(r.personaId, (out.get(r.personaId) ?? new Map()).set(r.itemKind, r.audience))
  return out
}

/** 팔로우하는(active) 사람으로서의 관계. 차단·숨김은 `myFollowees`가 이미 걸렀습니다. */
function followerViewer(sameInstitution: boolean): PersonaViewer {
  return { ...ANONYMOUS_VIEWER, signedIn: true, approvedFollower: true, sameInstitution }
}

/**
 * GET /feed?cursor= — 내 팔로우 피드(로그인 필요). 쓰기 시점 fan-out 없이 읽을 때 팔로우 × 페르소나 활동을 조인하고, 항목마다 공개 범위·차단·뮤트·
 * 원본 상태를 다시 확인합니다. 모르는 cursor 422.
 */
export async function getFeed(db: DbExecutor, actor: Actor, query: { cursor?: unknown } = {}): Promise<FeedDto> {
  const hasCursor = query.cursor !== undefined && query.cursor !== ''
  const cursor = hasCursor ? decodeFeedCursor(query.cursor) : null
  if (hasCursor && !cursor) throw invalid({ cursor: 'invalid' })
  return withSocialRole(db, async (tx) => {
    const followees = await myFollowees(tx, actor, false)
    const following = (await myFollowees(tx, actor, true)).length
    if (followees.length === 0) return { items: [], nextCursor: null, following }
    const mySchools = new Set(await activeAffiliationSchoolIds(tx, actor.userId))
    const theirSchools = await schoolsByUser(tx, [...new Set(followees.map((f) => f.persona.userId))])
    const stored = await visibilityByPersona(
      tx,
      followees.map((f) => f.persona.id),
    )
    const byKind = new Map<PersonaActivityItemKind, string[]>(ACTIVITY_KINDS.map((k) => [k, []]))
    const authors = new Map<string, FollowPersonaDto>()
    for (const f of followees) {
      const same = [...(theirSchools.get(f.persona.userId) ?? [])].some((s) => mySchools.has(s))
      for (const k of visibleKinds(f.persona, stored.get(f.persona.id) ?? new Map(), followerViewer(same))) byKind.get(k)!.push(f.persona.id)
      authors.set(f.persona.id, { kind: f.persona.kind, handle: f.persona.handle, displayName: personaDisplayName(f.persona, f.accountName) })
    }
    const allowed = [...byKind].filter(([, ids]) => ids.length > 0)
    if (allowed.length === 0) return { items: [], nextCursor: null, following }
    const allowedSql = sql.join(
      allowed.map(([kind, ids]) => sql`(${personaActivities.itemKind} = ${kind} and ${inArray(personaActivities.personaId, ids)})`),
      sql` or `,
    )
    const fetch = (after: FeedRankKey | null, n: number) =>
      tx
        .select(activityColumns)
        .from(personaActivities)
        .where(and(isNull(personaActivities.withdrawnAt), sql`(${allowedSql})`, after ? afterFeedKey(after) : undefined))
        .orderBy(desc(daySql), asc(bucketSql), desc(personaActivities.createdAt), desc(personaActivities.id))
        .limit(n) as Promise<ActivityRow[]>
    const { kept, next } = await fillPage(
      fetch,
      (rows) => loadCards(tx, actor.userId, rows.map((r) => r.id)),
      (r) => feedRankKey(r),
      cursor,
      FEED_PAGE_SIZE,
    )
    return {
      items: kept.map(({ row, card }) => toItem(row, card, authors.get(row.personaId)!, false)),
      nextCursor: next ? encodeFeedCursor(next) : null,
      following,
    }
  })
}

// ── 팔로우 추천 ───────────────────────────────────────────────────────────

const CANDIDATE_POOL = 200

/** 과목 정본 id(병합된 과목이면 정본). */
const canonicalCourseSql = sql<string>`coalesce(${courses.mergedInto}, ${courses.id})`

/**
 * GET /feed/suggestions — 팔로우 추천(로그인 필요). 같은 과목·같은 학교·관심 직무의 교집합으로만 점수를 매기고(@peerchive/domain
 * `suggestionScore`), 동점은 보는 사람마다 고정된 무작위 키로 가립니다. 팔로워 수·활동량은 읽지도 않습니다.
 */
export async function getFollowSuggestions(db: DbExecutor, actor: Actor): Promise<FollowSuggestionsDto> {
  return withSocialRole(db, async (tx) => {
    const mine = await tx.select({ id: personas.id }).from(personas).where(eq(personas.userId, actor.userId))
    // 내 과목: 내가 active 멤버인 과제의 학기 → 과목(정본).
    const myCourses = new Set(
      (
        await tx
          .selectDistinct({ courseId: canonicalCourseSql })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .innerJoin(courseTerms, eq(courseTerms.id, projects.courseTermId))
          .innerJoin(courses, eq(courses.id, courseTerms.courseId))
          .where(and(eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active')))
      ).map((r) => r.courseId),
    )
    const mySchools = new Set(await activeAffiliationSchoolIds(tx, actor.userId))
    const myTargets = new Set(
      (
        await tx
          .select({ targets: profiles.jobTargets })
          .from(profiles)
          .innerJoin(personas, eq(personas.id, profiles.personaId))
          .where(eq(personas.userId, actor.userId))
      ).flatMap((r) => r.targets.map((t) => t.trim().toLowerCase()).filter(Boolean)),
    )
    if (myCourses.size === 0 && mySchools.size === 0 && myTargets.size === 0) return { suggestions: [] }

    // 공통 제외: 나·이미 팔로우(요청 포함, 내 어느 페르소나로든)·내가 차단·뮤트한 바로 그 페르소나·나에게 숨겨진 페르소나·공개 상태가 아님.
    const eligible = and(
      ne(personas.userId, actor.userId),
      counterpartVisible(),
      notHiddenFrom(personas.id, personas.userId, actor.userId),
      sql`not exists (select 1 from ${follows} f where f.follower_user_id = ${actor.userId} and f.followee_persona_id = ${personas.id})`,
      sql`not exists (select 1 from ${blocks} b where b.blocker_user_id = ${actor.userId} and b.blocked_persona_id = ${personas.id})`,
      sql`not exists (select 1 from ${mutes} m where m.muter_user_id = ${actor.userId} and m.muted_persona_id = ${personas.id})`,
    )
    const candidateColumns = { persona: personas, accountName: users.displayName, jobTargets: profiles.jobTargets }
    const base = () =>
      tx
        .select(candidateColumns)
        .from(personas)
        .innerJoin(users, eq(users.id, personas.userId))
        .innerJoin(profiles, eq(profiles.personaId, personas.id))
    const pool = new Map<string, { persona: PersonaRow; accountName: string; jobTargets: string[] }>()
    const add = (rows: Array<{ persona: PersonaRow; accountName: string; jobTargets: string[] }>) => rows.forEach((r) => pool.set(r.persona.id, r))

    // 관심 직무(실명·표시명 모두: 공개 프로필에 이미 있는 값).
    if (myTargets.size) {
      add(
        await base()
          .where(and(eligible, sql`exists (select 1 from unnest(${profiles.jobTargets}) t where lower(trim(t)) in ${[...myTargets]})`))
          .limit(CANDIDATE_POOL),
      )
    }
    // 같은 학교: 실명 페르소나 + 학교 배지 공개만.
    const sameSchoolOwners = new Set<string>()
    if (mySchools.size) {
      const rows = await base()
        .where(
          and(
            eligible,
            eq(personas.kind, 'real'),
            eq(profiles.showAffiliationBadge, true),
            sql`exists (select 1 from ${institutionAffiliations} ia join ${schools} sc on sc.id = ia.school_id
              where ia.user_id = ${personas.userId} and ia.status = 'active' and coalesce(sc.merged_into, sc.id) in ${[...mySchools]})`,
          ),
        )
        .limit(CANDIDATE_POOL)
      add(rows)
      rows.forEach((r) => sameSchoolOwners.add(r.persona.userId))
    }
    // 같은 과목: 상대의 과제 수행 목록(실명 페르소나)에 내 과목이 있음. 볼 수 있는지는 아래에서 공개 범위로 판정.
    const listedCourses = new Map<string, Set<string>>()
    if (myCourses.size) {
      const rows = await tx
        .select({
          personaId: projectListings.personaId,
          courseId: canonicalCourseSql,
          kind: projects.kind,
          studyNameMode: projects.studyNameMode,
          membershipStatus: projectMembers.status,
        })
        .from(projectListings)
        .innerJoin(projectMembers, eq(projectMembers.id, projectListings.projectMemberId))
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .innerJoin(courseTerms, eq(courseTerms.id, projects.courseTermId))
        .innerJoin(courses, eq(courses.id, courseTerms.courseId))
        .where(and(isNull(projectListings.hiddenAt), ne(projectListings.userId, actor.userId), sql`${canonicalCourseSql} in ${[...myCourses]}`))
        .limit(CANDIDATE_POOL * 5)
      for (const r of rows) if (listingBlock('real', r) === null) listedCourses.set(r.personaId, (listedCourses.get(r.personaId) ?? new Set()).add(r.courseId))
      if (listedCourses.size) add(await base().where(and(eligible, inArray(personas.id, [...listedCourses.keys()]))).limit(CANDIDATE_POOL))
    }
    if (pool.size === 0) return { suggestions: [] }

    // 과목 신호는 내가 그 사람의 과제 수행 목록을 볼 수 있을 때만(같은 기관·승인 팔로워 판정 포함 — 추천 대상은 아직 팔로우하지 않은 사람).
    const candidates = [...pool.values()]
    const theirSchools = await schoolsByUser(tx, [...new Set(candidates.map((c) => c.persona.userId))])
    const stored = await visibilityByPersona(
      tx,
      candidates.map((c) => c.persona.id),
    )
    const mineIds = new Set(mine.map((m) => m.id))
    const scored: Array<SuggestionCandidate & { row: (typeof candidates)[number] }> = []
    for (const c of candidates) {
      if (mineIds.has(c.persona.id)) continue
      const same = [...(theirSchools.get(c.persona.userId) ?? [])].some((s) => mySchools.has(s))
      const viewer: PersonaViewer = { ...ANONYMOUS_VIEWER, signedIn: true, sameInstitution: same }
      const courseCount =
        c.persona.kind === 'real' && canViewPersonaItem(c.persona, 'project_list', stored.get(c.persona.id)?.get('project_list') ?? null, viewer)
          ? (listedCourses.get(c.persona.id)?.size ?? 0)
          : 0
      const signals: SuggestionSignals = {
        sharedCourses: courseCount,
        sameInstitution: c.persona.kind === 'real' && sameSchoolOwners.has(c.persona.userId),
        sharedJobTargets: new Set(c.jobTargets.map((t) => t.trim().toLowerCase()).filter((t) => myTargets.has(t))).size,
      }
      scored.push({
        personaId: c.persona.id,
        ownerKey: c.persona.userId,
        signals,
        tieKey: createHash('sha256').update(`${actor.userId}:${c.persona.id}`).digest('hex'),
        row: c,
      })
    }
    return {
      suggestions: rankSuggestions(scored).map(
        (s): FollowSuggestionDto => ({
          kind: s.row.persona.kind,
          handle: s.row.persona.handle,
          displayName: personaDisplayName(s.row.persona, s.row.accountName),
          accountPrivacy: s.row.persona.accountPrivacy,
          reasons: suggestionReasons(s.signals),
        }),
      ),
    }
  })
}
