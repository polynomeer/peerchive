/**
 * 항목별 공개 범위·과제 수행 목록 (S-03, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 VisibilitySetting·ProjectListing·§8.3·§9.2,
 * DELIVERY_PLAN §4.2 S-03·§5.2 S, ADR 0031).
 *
 * social 모듈입니다: 커뮤니티 글 테이블·커뮤니티 모듈을 import하지 않습니다(S-02 경계 테스트). 과제·학기·과목·엠바고·학교 인증은 커뮤니티
 * 테이블이 아니며, social DB 역할에는 여기서 읽는 열만 SELECT로 줍니다(migration 0028·0029 `peerchive_apply_social_grants`).
 *
 * - **정책**: 판정은 모두 @peerchive/domain `canViewPersona`·`canViewPersonaItem`이 합니다. 이 파일은 보는 사람(`personaViewerFor`)과
 *   저장 값(`loadVisibility`)만 모읍니다. 공개 경로(공개 프로필 JSON·HTML·OG·인쇄 보기·README 카드)는 쿠키를 읽지 않으므로 늘 비로그인
 *   (`ANONYMOUS_VIEWER`)으로 판정하고, 로그인 상태를 반영한 목록은 `GET /profiles/:handle/projects`(세션을 읽음)만 줍니다.
 * - **승인된 팔로워·차단**(S-04, ADR 0033): `personaViewerFor`가 팔로우 행(active)으로 `approvedFollower`를, 차단 행(범위가 이 페르소나를 덮는 것)으로
 *   `blocked`를 채웁니다. 차단당한 사용자는 `canViewPersona`에서 404입니다.
 * - **공개 사례·케이스 스터디는 이 설정의 대상이 아닙니다**(§8.3 불변조건 2). PUT은 그런 항목 이름을 422로 거부하고, 공개 사례 목록은 계속
 *   공개 절차(동의·게시)를 거친 것만 나옵니다.
 * - **과제 수행 목록**은 실명 페르소나만, active 멤버가 직접 고른 과제만, 과목·학기·제목만(엠바고 중이면 제목 없이) 싣습니다. 익명·표시명
 *   스터디 방의 기록은 올릴 수 없고, 읽을 때도 같은 규칙(`listingBlock`)으로 다시 거릅니다. 과제 공간의 읽기 권한(§8)은 건드리지 않습니다.
 * - 다른 사람의 페르소나·없는 id는 404입니다. 감사에는 항목 종류·플래그만 남깁니다.
 */
import { z } from 'zod'
import {
  and,
  courseTerms,
  courses,
  embargoes,
  eq,
  inArray,
  isNull,
  personas,
  projectListings,
  projectMembers,
  projects,
  sql,
  visibilitySettings,
  type DbExecutor,
  type SQL,
} from '@peerchive/db'
import {
  ANONYMOUS_VIEWER,
  SEMESTER_LABELS,
  VISIBILITY_AUDIENCES,
  VISIBILITY_ITEM_KINDS,
  type PersonaViewer,
  type VisibilityAudience,
  type VisibilityItemKind,
  canViewPersona,
  canViewPersonaItem,
  computeEffectiveEmbargo,
  defaultAudience,
  effectiveAudience,
  isAllowedAudience,
  isVisibilityItemKind,
  listingBlock,
} from '@peerchive/domain'
import { activeAffiliationSchoolIds } from '../affiliation/affiliations'
import { emitSocialAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound } from '../errors'
import { resolvePublicPersona } from './personas'
import { isApprovedFollower, isHiddenFrom } from './relations'
import type {
  MyProjectListingDto,
  MyProjectListingsDto,
  PersonaVisibilityDto,
  ProfileProjectsDto,
  PublicProjectListingDto,
  VisibilitySettingDto,
} from '../../../shared/types/api'

type PersonaRow = typeof personas.$inferSelect

// ── 보는 사람·저장 값 ────────────────────────────────────────────────────

/**
 * 보는 사람과 페르소나 주인의 관계. 로그인하지 않았으면 `ANONYMOUS_VIEWER`.
 * same_institution은 두 사람의 active 학교 인증이 같은 정본 학교를 가리키는지로 봅니다(§8.3).
 * S-04(ADR 0033): `approvedFollower` = 보는 사람이 어느 페르소나로든 이 페르소나를 active로 팔로우함, `blocked` = 주인이 보는 사람을 차단했고 그 범위가
 * 이 페르소나를 덮음(`isHiddenFrom`). 차단당했으면 나머지는 읽지 않습니다.
 */
export async function personaViewerFor(db: DbExecutor, persona: Pick<PersonaRow, 'id' | 'userId'>, actor: Actor | null): Promise<PersonaViewer> {
  if (!actor) return ANONYMOUS_VIEWER
  if (actor.userId === persona.userId) return { ...ANONYMOUS_VIEWER, isOwner: true, signedIn: true }
  if (await isHiddenFrom(db, persona, actor.userId)) return { ...ANONYMOUS_VIEWER, signedIn: true, blocked: true }
  const [mine, theirs] = await Promise.all([activeAffiliationSchoolIds(db, actor.userId), activeAffiliationSchoolIds(db, persona.userId)])
  const theirSet = new Set(theirs)
  return {
    ...ANONYMOUS_VIEWER,
    signedIn: true,
    sameInstitution: mine.some((id) => theirSet.has(id)),
    approvedFollower: await isApprovedFollower(db, persona.id, actor.userId),
  }
}

/** 페르소나의 저장된 공개 범위(행이 없는 항목은 빠짐 → 기본값). */
export async function loadVisibility(db: DbExecutor, personaId: string): Promise<Map<VisibilityItemKind, VisibilityAudience>> {
  const rows = await db
    .select({ itemKind: visibilitySettings.itemKind, audience: visibilitySettings.audience })
    .from(visibilitySettings)
    .where(eq(visibilitySettings.personaId, personaId))
  return new Map(rows.map((r) => [r.itemKind, r.audience]))
}

/** 이 페르소나의 이 항목을 이 사람이 볼 수 있는지(도메인 `canViewPersonaItem` + 저장 값). */
export async function canViewItem(db: DbExecutor, persona: Pick<PersonaRow, 'id' | 'status' | 'accountPrivacy'>, itemKind: VisibilityItemKind, viewer: PersonaViewer): Promise<boolean> {
  if (viewer.isOwner) return canViewPersonaItem(persona, itemKind, null, viewer)
  const [row] = await db
    .select({ audience: visibilitySettings.audience })
    .from(visibilitySettings)
    .where(and(eq(visibilitySettings.personaId, persona.id), eq(visibilitySettings.itemKind, itemKind)))
    .limit(1)
  return canViewPersonaItem(persona, itemKind, row?.audience ?? null, viewer)
}

// ── 본인: 공개 범위 ──────────────────────────────────────────────────────

/** 이 페르소나·항목이 받는 값. 표시명 페르소나의 과제 수행 목록은 private만(과제 수행 목록은 실명 페르소나만). */
function allowedAudiences(persona: Pick<PersonaRow, 'kind'>, itemKind: VisibilityItemKind): VisibilityAudience[] {
  if (itemKind === 'project_list' && persona.kind !== 'real') return ['private']
  return VISIBILITY_AUDIENCES.filter((a) => isAllowedAudience(itemKind, a))
}

async function myPersonaOr404(db: DbExecutor, actor: Actor, rawId: unknown, lock = false): Promise<PersonaRow> {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  const query = db
    .select()
    .from(personas)
    .where(and(eq(personas.id, id.data.toLowerCase()), eq(personas.userId, actor.userId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

function toVisibilityDto(persona: PersonaRow, stored: Map<VisibilityItemKind, VisibilityAudience>): PersonaVisibilityDto {
  return {
    personaId: persona.id,
    kind: persona.kind,
    accountPrivacy: persona.accountPrivacy,
    items: VISIBILITY_ITEM_KINDS.map((itemKind): VisibilitySettingDto => {
      const saved = stored.get(itemKind) ?? null
      return {
        itemKind,
        audience: saved ?? defaultAudience(itemKind, persona.accountPrivacy),
        isDefault: saved === null,
        effective: effectiveAudience(itemKind, saved, persona.accountPrivacy),
        allowed: allowedAudiences(persona, itemKind),
      }
    }),
  }
}

/** GET /personas/:id/visibility — 내 페르소나의 항목별 공개 범위. 남의 것·없는 id는 404. */
export async function getMyVisibility(db: DbExecutor, actor: Actor, rawId: unknown): Promise<PersonaVisibilityDto> {
  const persona = await myPersonaOr404(db, actor, rawId)
  return toVisibilityDto(persona, await loadVisibility(db, persona.id))
}

/** 공개 사례 쪽 이름. 이 설정으로 넓힐 수 없다는 뜻의 다른 오류 코드를 줍니다(공개 절차 경유). */
const PUBLICATION_ITEM_NAMES = new Set(['cases', 'case_studies', 'case_study', 'publications', 'publication', 'portfolio', 'releases'])

/**
 * PUT /personas/:id/visibility {items: {itemKind: audience}} — 바꿀 항목만 보냅니다. 남의 것·없는 id는 404.
 * 422: 목록 밖 항목(`items.<이름>`: 공개 사례 쪽이면 `publication_procedure`, 그 밖은 `unknown_item`), 받지 않는 값(`invalid`, follow_lists는
 * public·private만), 표시명 페르소나의 project_list를 private 밖으로(`real_persona_only`), 빈 요청(`items: required`).
 * 같은 값이면 쓰지 않습니다. 감사 `persona.visibility_update`에는 페르소나 종류와 바뀐 항목 이름만 남깁니다.
 */
export async function setVisibility(db: DbExecutor, actor: Actor, rawId: unknown, rawInput: unknown, now = new Date()): Promise<PersonaVisibilityDto> {
  // 남의 페르소나에는 입력 오류보다 404를 먼저 줍니다(존재를 드러내지 않음).
  await myPersonaOr404(db, actor, rawId)
  const items = (rawInput as { items?: unknown } | null)?.items
  if (!items || typeof items !== 'object' || Array.isArray(items) || Object.keys(items).length === 0) throw invalid({ items: 'required' })
  return db.transaction(async (tx) => {
    const persona = await myPersonaOr404(tx, actor, rawId, true)
    const fields: Record<string, string> = {}
    const wanted = new Map<VisibilityItemKind, VisibilityAudience>()
    for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
      if (!isVisibilityItemKind(key)) {
        fields[`items.${key}`] = PUBLICATION_ITEM_NAMES.has(key) ? 'publication_procedure' : 'unknown_item'
        continue
      }
      if (!isAllowedAudience(key, value)) fields[`items.${key}`] = 'invalid'
      else if (!allowedAudiences(persona, key).includes(value)) fields[`items.${key}`] = 'real_persona_only'
      else wanted.set(key, value)
    }
    if (Object.keys(fields).length) throw invalid(fields)
    const stored = await loadVisibility(tx, persona.id)
    const changed = [...wanted].filter(([k, a]) => stored.get(k) !== a)
    if (changed.length === 0) return toVisibilityDto(persona, stored)
    for (const [itemKind, audience] of changed) {
      await tx
        .insert(visibilitySettings)
        .values({ personaId: persona.id, itemKind, audience, updatedAt: now })
        .onConflictDoUpdate({ target: [visibilitySettings.personaId, visibilitySettings.itemKind], set: { audience, updatedAt: now } })
      stored.set(itemKind, audience)
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'persona.visibility_update',
      targetType: 'persona',
      targetId: persona.id,
      metadata: { kind: persona.kind, items: changed.map(([k]) => k).sort().join(',') },
    })
    // §6.2 visibility_changed(item_kind·audience)(S-07): 항목마다 한 줄, 페르소나 id·종류 없음.
    for (const [itemKind, audience] of changed) await emitSocialAnalytics(tx, { name: 'visibility_changed', actorId: actor.userId, props: { itemKind, audience }, now })
    return toVisibilityDto(persona, stored)
  })
}

// ── 과제 행·엠바고 ───────────────────────────────────────────────────────

interface ProjectFacts {
  projectId: string
  memberId: string
  membershipStatus: 'invited' | 'active' | 'left' | 'removed'
  title: string
  kind: 'individual' | 'team' | 'study'
  studyNameMode: 'real' | 'display' | 'anonymous' | 'affiliated_anonymous' | null
  courseTermId: string | null
  embargoUntil: Date | null
  courseTitle: string | null
  year: number | null
  semester: keyof typeof SEMESTER_LABELS | null
}

const projectFactsColumns = {
  projectId: projects.id,
  memberId: projectMembers.id,
  membershipStatus: projectMembers.status,
  title: projects.title,
  kind: projects.kind,
  studyNameMode: projects.studyNameMode,
  courseTermId: projects.courseTermId,
  embargoUntil: projects.embargoUntil,
  // 병합된 과목이면 정본 과목의 이름(학기는 병합 때 정본으로 옮겨짐, catalog/merge.ts).
  courseTitle: sql<string | null>`coalesce((select cc.title from ${courses} cc where cc.id = ${courses.mergedInto}), ${courses.title})`,
  year: courseTerms.year,
  semester: courseTerms.semester,
}

/** 멤버십 → 과제 → (학기 → 과목). 과목·학기 이름과 엠바고·익명 판정에 쓰는 열만 읽습니다(social 역할 열 권한과 같음). */
async function loadProjectFacts(db: DbExecutor, where: SQL | undefined): Promise<ProjectFacts[]> {
  return db
    .select(projectFactsColumns)
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .leftJoin(courseTerms, eq(courseTerms.id, projects.courseTermId))
    .leftJoin(courses, eq(courses.id, courseTerms.courseId))
    .where(where)
}

/** 과제마다 적용 엠바고가 지금 걸려 있는지(embargo 모듈 `getProjectEmbargo`와 같은 계산을 한 번에). */
async function activeEmbargoes(db: DbExecutor, rows: ProjectFacts[], now: Date): Promise<Set<string>> {
  if (rows.length === 0) return new Set()
  const projectIds = [...new Set(rows.map((r) => r.projectId))]
  const termIds = [...new Set(rows.flatMap((r) => (r.courseTermId ? [r.courseTermId] : [])))]
  const explicit = await db
    .select({ projectId: embargoes.projectId, courseTermId: embargoes.courseTermId, until: embargoes.until })
    .from(embargoes)
    .where(
      and(
        isNull(embargoes.revokedAt),
        termIds.length
          ? sql`(${inArray(embargoes.projectId, projectIds)} or ${inArray(embargoes.courseTermId, termIds)})`
          : inArray(embargoes.projectId, projectIds),
      ),
    )
  const active = new Set<string>()
  for (const r of rows) {
    const embargo = computeEffectiveEmbargo(
      {
        projectEmbargoUntil: r.embargoUntil,
        courseTermEmbargoes: r.courseTermId ? explicit.filter((e) => e.courseTermId === r.courseTermId).map((e) => e.until) : [],
        projectEmbargoes: explicit.filter((e) => e.projectId === r.projectId).map((e) => e.until),
      },
      now,
    )
    if (embargo.active) active.add(r.projectId)
  }
  return active
}

const termLabelOf = (r: Pick<ProjectFacts, 'year' | 'semester'>) => (r.year !== null && r.semester ? `${r.year}년 ${SEMESTER_LABELS[r.semester]}` : null)

const SEMESTER_ORDER: Readonly<Record<string, number>> = { spring: 1, summer: 2, fall: 3, winter: 4 }
/** 최근 학기 먼저, 학기 없는 과제는 뒤로. */
const byTermDesc = (a: Pick<ProjectFacts, 'year' | 'semester'>, b: Pick<ProjectFacts, 'year' | 'semester'>) =>
  (b.year ?? -1) - (a.year ?? -1) || (b.semester ? (SEMESTER_ORDER[b.semester] ?? 0) : 0) - (a.semester ? (SEMESTER_ORDER[a.semester] ?? 0) : 0)

// ── 공개: 과제 수행 목록 ─────────────────────────────────────────────────

/**
 * 공개 프로필의 과제 수행 목록. 볼 수 없으면 null(표시명 페르소나는 늘 null). 노출 필드는 과목·학기·제목뿐이고 엠바고 중이면 제목 null.
 * 읽을 때마다 active 멤버·익명 스터디 규칙(`listingBlock`)과 엠바고를 다시 확인합니다. 다른 멤버·로그·파일·과제 id는 읽지도 않습니다.
 */
export async function visiblePersonaProjects(
  db: DbExecutor,
  persona: Pick<PersonaRow, 'id' | 'kind' | 'status' | 'accountPrivacy'>,
  viewer: PersonaViewer,
  now = new Date(),
): Promise<PublicProjectListingDto[] | null> {
  if (persona.kind !== 'real') return null
  if (!(await canViewItem(db, persona, 'project_list', viewer))) return null
  const rows = await db
    .select({ ...projectFactsColumns, shownAt: projectListings.shownAt })
    .from(projectListings)
    .innerJoin(projectMembers, eq(projectMembers.id, projectListings.projectMemberId))
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .leftJoin(courseTerms, eq(courseTerms.id, projects.courseTermId))
    .leftJoin(courses, eq(courses.id, courseTerms.courseId))
    .where(and(eq(projectListings.personaId, persona.id), isNull(projectListings.hiddenAt)))
  const listable = rows.filter((r) => listingBlock(persona.kind, r) === null)
  const embargoed = await activeEmbargoes(db, listable, now)
  return listable
    .sort((a, b) => byTermDesc(a, b) || b.shownAt.getTime() - a.shownAt.getTime())
    .map((r) => ({ courseTitle: r.courseTitle, termLabel: termLabelOf(r), title: embargoed.has(r.projectId) ? null : r.title }))
}

/**
 * `GET /profiles/:handle`의 과제 수행 목록 — 로그인 상태를 반영합니다(세션을 읽는 경로). 공개 화면은 SSR 뒤 브라우저에서만 부르므로 보는 사람의
 * 정보가 공개 HTML·payload에 들어가지 않습니다. 없는·비공개 상태 handle 404, 볼 수 없으면 `{projects: null}`.
 */
export async function getProfileProjects(db: DbExecutor, actor: Actor | null, rawHandle: unknown, now = new Date()): Promise<ProfileProjectsDto> {
  const { persona } = await resolvePublicPersona(db, rawHandle)
  const viewer = await personaViewerFor(db, persona, actor)
  if (!canViewPersona(persona, viewer)) throw notFound()
  return { projects: await visiblePersonaProjects(db, persona, viewer, now) }
}

// ── 본인: 과제 수행 목록 고르기 ───────────────────────────────────────────

async function myRealPersona(db: DbExecutor, actor: Actor, rawId: unknown, lock = false): Promise<PersonaRow> {
  const persona = await myPersonaOr404(db, actor, rawId, lock)
  // 표시명 프로필에 팀 과제를 올리면 팀원이 두 프로필을 이을 수 있습니다(ADR 0031).
  if (persona.kind !== 'real') throw conflict('real_persona_only')
  return persona
}

/** GET /personas/:id/project-listings — 내가 active 멤버인 과제와 목록에 올렸는지. 표시명 페르소나는 409 `real_persona_only`. */
export async function listMyProjectListings(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<MyProjectListingsDto> {
  const persona = await myRealPersona(db, actor, rawId)
  const rows = await loadProjectFacts(db, and(eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active')))
  const listed = new Set(
    (
      await db
        .select({ memberId: projectListings.projectMemberId })
        .from(projectListings)
        .where(and(eq(projectListings.personaId, persona.id), isNull(projectListings.hiddenAt)))
    ).map((r) => r.memberId),
  )
  const embargoed = await activeEmbargoes(db, rows, now)
  const stored = await loadVisibility(db, persona.id)
  return {
    personaId: persona.id,
    audience: effectiveAudience('project_list', stored.get('project_list'), persona.accountPrivacy),
    projects: rows.sort((a, b) => byTermDesc(a, b) || a.title.localeCompare(b.title, 'ko')).map((r): MyProjectListingDto => {
      const block = listingBlock(persona.kind, r)
      return {
        projectId: r.projectId,
        title: r.title,
        courseTitle: r.courseTitle,
        termLabel: termLabelOf(r),
        embargoActive: embargoed.has(r.projectId),
        listed: block === null && listed.has(r.memberId),
        block: block === 'anonymous_study' || block === 'display_study' ? block : null,
      }
    }),
  }
}

const listingInput = z.object({
  // 과제 id가 아니거나 없으면 404(남의 과제와 구분하지 않음).
  projectId: z.unknown(),
  shown: z.boolean({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }),
})

/**
 * PUT /personas/:id/project-listings {projectId, shown} — 과제를 과제 수행 목록에 올리거나 내립니다.
 * 남의 페르소나·내가 active 멤버가 아닌 과제는 404, 표시명 페르소나 409 `real_persona_only`, 익명 스터디 방 기록 409 `anonymous_study`,
 * 표시명 스터디 방 기록 409 `display_study`(내리기는 언제나 됨). 바뀌지 않으면 쓰지 않습니다. 감사에는 `{shown}` 플래그만.
 * 과제 공간의 멤버십·읽기 권한은 바꾸지 않습니다.
 */
export async function setProjectListing(
  db: DbExecutor,
  actor: Actor,
  rawPersonaId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<MyProjectListingsDto> {
  await myPersonaOr404(db, actor, rawPersonaId)
  const parsed = listingInput.safeParse(rawInput ?? {})
  if (!parsed.success) throw invalid({ shown: parsed.error.issues[0]?.message === 'required' ? 'required' : 'invalid' })
  const { shown } = parsed.data
  const projectId = z.uuid().safeParse(parsed.data.projectId)
  if (!projectId.success) throw notFound()
  await db.transaction(async (tx) => {
    const persona = await myRealPersona(tx, actor, rawPersonaId, true)
    const [row] = await loadProjectFacts(tx, and(eq(projectMembers.projectId, projectId.data.toLowerCase()), eq(projectMembers.userId, actor.userId)))
    if (!row || row.membershipStatus !== 'active') throw notFound()
    const [existing] = await tx
      .select({ hiddenAt: projectListings.hiddenAt })
      .from(projectListings)
      .where(and(eq(projectListings.projectMemberId, row.memberId), eq(projectListings.personaId, persona.id)))
      .limit(1)
      .for('update')
    if (shown) {
      const block = listingBlock(persona.kind, row)
      if (block) throw conflict(block)
      if (existing && existing.hiddenAt === null) return
      await tx
        .insert(projectListings)
        .values({ projectMemberId: row.memberId, personaId: persona.id, personaKind: 'real', userId: actor.userId, shownAt: now, hiddenAt: null })
        .onConflictDoUpdate({ target: [projectListings.projectMemberId, projectListings.personaId], set: { shownAt: now, hiddenAt: null } })
    } else {
      if (!existing || existing.hiddenAt !== null) return
      await tx
        .update(projectListings)
        .set({ hiddenAt: now })
        .where(and(eq(projectListings.projectMemberId, row.memberId), eq(projectListings.personaId, persona.id)))
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'persona.project_listing_update',
      targetType: 'persona',
      targetId: persona.id,
      projectId: row.projectId,
      metadata: { shown },
    })
    // §6.2 project_listed(S-07): 올림·내림만(과제 키 없음 — 과제 수행 목록 이벤트로 과제와 사람을 잇지 않음).
    await emitSocialAnalytics(tx, { name: 'project_listed', actorId: actor.userId, props: { listed: shown }, now })
  })
  return listMyProjectListings(db, actor, rawPersonaId, now)
}

