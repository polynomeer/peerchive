/**
 * 학교를 넘나드는 토픽과 소속 표시 익명·임계값 (A-05, PROOFU_EVOLUTION_PLAN §4.4 1단계·§8.9.10, SYSTEM_DESIGN §6.7.2·§8.4·§9.2,
 * DELIVERY_PLAN §4.3 A-05·§5.3 Y, ADR 0042).
 *
 * - 토픽은 `community_spaces.kind = topic`(학교 없음, 이름 표시 `affiliated_anonymous` 고정, 게시판 하나, 멤버십 없음)입니다. **운영자만** 만듭니다
 *   (`POST /operator/community/topics`, CLI `pnpm --filter @peerchive/db topic create`). 읽기·쓰기는 active 기관 인증이 하나라도 있는 계정
 *   (canReadSpace·canWriteBoard, 대학·부트캠프 무관), 운영자는 읽기만. P2 `topics` 플래그가 꺼지면 목록·만들기·토픽 공간의 모든 경로가 404입니다
 *   (access.ts loadSpaceContext).
 * - **소속 표시는 쓰는 순간 정해 글·댓글 행에 고정합니다**(affiliationLabelAtWrite): 작성자가 고른 범위(기관 이름/기관 종류/표시 안 함) + 그 순간의
 *   (정본 기관, 신분)·(기관 종류, 신분) 인증 회원 수 → @peerchive/domain decideAffiliationLabel(두 단계: 기관이 적으면 종류로, 종류도 적으면 표시 안 함). 회원 수는 이 트랜잭션 안에서 세고 어디에도 저장·응답하지 않습니다.
 *   이후 회원이 늘거나 소속이 바뀌거나 해제돼도 이미 쓴 글의 표시는 그대로입니다(DB 고정 열 트리거).
 * - 넓혀졌는지(`broadened`)는 글쓰기 화면의 미리보기(본인 소속만)와 본인 글 응답(`labelBroadened`)에만 있습니다. 행에는 고른 범위·적용 범위가
 *   남지만 응답은 작성자 본인에게만 둘을 비교한 값을 싣습니다.
 * - 학과(자기 신고)·기수·입학연도는 읽지도 않습니다. 감사 기록·분석 이벤트에 소속 id·표시 문자열을 넣지 않습니다(글 작성 감사 없음, ADR 0022).
 */
import { z } from 'zod'
import {
  AFFILIATION_LABEL_BROADENED_NOTE,
  AFFILIATION_LABEL_SCOPES,
  AFFILIATION_LABEL_THRESHOLD,
  DEFAULT_AFFILIATION_LABEL_SCOPE,
  SPACE_DESCRIPTION_MAX,
  TOPIC_CATEGORIES,
  TOPIC_DEFAULT_BOARDS,
  type AffiliationLabelDecision,
  type AffiliationLabelScope,
  type AffiliationStandingValue,
  type InstitutionKindValue,
  checkSpaceName,
  decideAffiliationLabel,
  institutionAffiliationLabel,
  labelKey,
} from '@peerchive/domain'
import { and, communitySpaces, desc, eq, inArray, institutionAffiliations, isNotNull, schools, sql, users, type DbExecutor } from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, conflict, invalid } from '../errors'
import { requireFeature } from '../features'
import { parseInput } from '../validation'
import { loadViewer } from './access'
import { getSpaceDetail, insertSpace } from './spaces'
import type { SpaceDetailDto, TopicComposerAffiliationDto, TopicListDto } from '../../../shared/types/api'

/**
 * 임계값(설정값, SYSTEM_DESIGN §6.7.2 "초기안 50, 설정값"). `PEERCHIVE_AFFILIATION_LABEL_THRESHOLD`(정수 5~10000)가 있으면 그 값, 없거나 틀리면 50.
 * 5보다 작게 낮출 수 없습니다(n ≥ 5 익명 집계 원칙의 하한). 요청마다 읽습니다(바꾸려면 재시작).
 */
export function affiliationLabelThreshold(): number {
  const raw = globalThis.process?.env?.PEERCHIVE_AFFILIATION_LABEL_THRESHOLD?.trim()
  if (!raw || !/^\d+$/.test(raw)) return AFFILIATION_LABEL_THRESHOLD
  const n = Number(raw)
  return n >= 5 && n <= 10_000 ? n : AFFILIATION_LABEL_THRESHOLD
}

// ── 소속과 회원 수 ────────────────────────────────────────────────────────

/** 작성자의 active 소속 하나(정본 기관 이름·종류). 학과·기수는 읽지 않습니다. */
export interface LabelAffiliation {
  affiliationId: string
  institutionId: string
  institutionName: string
  institutionKind: InstitutionKindValue
  standing: AffiliationStandingValue
}

/** 내 active 인증 소속(최근 인증 순). 병합된 학교는 정본의 이름·종류로 읽습니다. */
export async function myLabelAffiliations(db: DbExecutor, userId: string): Promise<LabelAffiliation[]> {
  const rows = await db
    .select({
      affiliationId: institutionAffiliations.id,
      institutionId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
      institutionName: sql<string>`coalesce((select c.name from schools c where c.id = ${schools.mergedInto}), ${schools.name})`,
      institutionKind: sql<InstitutionKindValue>`coalesce((select c.kind from schools c where c.id = ${schools.mergedInto}), ${schools.kind})::text`,
      standing: institutionAffiliations.standing,
    })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(and(eq(institutionAffiliations.userId, userId), eq(institutionAffiliations.status, 'active'), isNotNull(institutionAffiliations.verifiedAt)))
    .orderBy(desc(institutionAffiliations.verifiedAt), desc(institutionAffiliations.id))
  return rows
}

/**
 * 임계값 판정에 세는 (정본 기관, 신분)의 인증 회원 수(@peerchive/domain countsTowardLabelThreshold와 같은 조건): active + verified_at 있음 +
 * active 계정, 사람 단위로 한 번. pending·만료·철회 소속, 정지·탈퇴 계정, 다른 신분은 세지 않습니다. 결과는 판정에만 쓰고 응답·로그에 싣지 않습니다.
 */
export async function verifiedMemberCount(db: DbExecutor, institutionId: string, standing: AffiliationStandingValue): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${institutionAffiliations.userId})::int` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .innerJoin(users, eq(users.id, institutionAffiliations.userId))
    .where(
      and(
        sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${institutionId}`,
        eq(institutionAffiliations.standing, standing),
        eq(institutionAffiliations.status, 'active'),
        isNotNull(institutionAffiliations.verifiedAt),
        eq(users.status, 'active'),
      ),
    )
  return row?.n ?? 0
}

/**
 * 넓힌 범주(기관 종류, 신분)의 인증 회원 수: 그 종류의 모든 정본 기관을 합쳐 verifiedMemberCount와 같은 규칙(active + verified_at + active 계정,
 * 사람 단위)으로 셉니다. 기관 종류는 정본 기관의 종류입니다(병합된 학교의 소속은 정본 종류로). 판정에만 쓰고 응답·로그에 싣지 않습니다.
 */
export async function verifiedCategoryCount(db: DbExecutor, kind: InstitutionKindValue, standing: AffiliationStandingValue): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${institutionAffiliations.userId})::int` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .innerJoin(users, eq(users.id, institutionAffiliations.userId))
    .where(
      and(
        sql`coalesce((select c.kind from schools c where c.id = ${schools.mergedInto}), ${schools.kind})::text = ${kind}`,
        eq(institutionAffiliations.standing, standing),
        eq(institutionAffiliations.status, 'active'),
        isNotNull(institutionAffiliations.verifiedAt),
        eq(users.status, 'active'),
      ),
    )
  return row?.n ?? 0
}

interface MemberCounts {
  institution: number
  category: number
}

async function memberCounts(db: DbExecutor, aff: LabelAffiliation): Promise<MemberCounts> {
  const [institution, category] = await Promise.all([
    verifiedMemberCount(db, aff.institutionId, aff.standing),
    verifiedCategoryCount(db, aff.institutionKind, aff.standing),
  ])
  return { institution, category }
}

function decide(aff: LabelAffiliation, requested: AffiliationLabelScope, counts: MemberCounts): AffiliationLabelDecision {
  return decideAffiliationLabel({
    requested,
    institution: { name: aff.institutionName, kind: aff.institutionKind },
    standing: aff.standing,
    verifiedMembers: counts.institution,
    categoryMembers: counts.category,
    threshold: affiliationLabelThreshold(),
  })
}

/** 글쓰기 화면의 소속 표시 고르기(본인 소속만, 회원 수 없이 범위별 결과와 넓혀졌는지만). */
export async function topicComposerAffiliation(db: DbExecutor, userId: string): Promise<TopicComposerAffiliationDto> {
  const mine = await myLabelAffiliations(db, userId)
  const options = await Promise.all(
    mine.map(async (aff) => {
      const members = await memberCounts(db, aff)
      const previews = Object.fromEntries(
        AFFILIATION_LABEL_SCOPES.map((scope) => {
          const d = decide(aff, scope, members)
          return [scope, { label: d.label, broadened: d.broadened }]
        }),
      ) as TopicComposerAffiliationDto['options'][number]['previews']
      return { affiliationId: aff.affiliationId, title: institutionAffiliationLabel(aff.institutionName, aff.institutionKind, aff.standing), previews }
    }),
  )
  return { scopes: [...AFFILIATION_LABEL_SCOPES], defaultScope: DEFAULT_AFFILIATION_LABEL_SCOPE, options, broadenedNote: AFFILIATION_LABEL_BROADENED_NOTE }
}

/** 글·댓글 행에 고정할 소속 표시 열. */
export interface AffiliationLabelColumns {
  affiliationId: string | null
  labelScopeRequested: AffiliationLabelScope
  labelScopeApplied: AffiliationLabelScope
  affiliationLabel: string | null
}

export const affiliationInputSchema = {
  affiliationScope: z.enum(AFFILIATION_LABEL_SCOPES, { error: 'invalid' }).nullish(),
  affiliationId: z.uuid({ error: 'invalid' }).nullish(),
}

/**
 * 쓰는 트랜잭션 안에서(공간 FOR SHARE 잠금 뒤) 고정할 소속 표시. 표시 안 함이면 소속을 고르지 않습니다(affiliation_id null).
 * 임계값으로 표시 안 함이 되면(범주도 적음) 표시가 없으므로 소속 id도 남기지 않습니다.
 * 고른 소속(affiliationId)은 내 active 인증 소속이어야 합니다(아니면 422 `affiliationId: invalid`). 없으면 가장 최근에 인증한 소속.
 * 내 소속이 하나도 없으면 403 `write_not_allowed`(canWriteBoard가 먼저 막으므로 경쟁 상태에서만).
 */
export async function affiliationLabelAtWrite(
  tx: DbExecutor,
  userId: string,
  input: { affiliationScope?: AffiliationLabelScope | null; affiliationId?: string | null },
): Promise<AffiliationLabelColumns> {
  const requested = input.affiliationScope ?? DEFAULT_AFFILIATION_LABEL_SCOPE
  if (requested === 'none') {
    if (input.affiliationId) throw invalid({ affiliationId: 'not_applicable' })
    return { affiliationId: null, labelScopeRequested: 'none', labelScopeApplied: 'none', affiliationLabel: null }
  }
  const mine = await myLabelAffiliations(tx, userId)
  const aff = input.affiliationId ? mine.find((a) => a.affiliationId === input.affiliationId!.toLowerCase()) : mine[0]
  if (!aff) throw input.affiliationId ? invalid({ affiliationId: 'invalid' }) : conflict('affiliation_required')
  const d = decide(aff, requested, await memberCounts(tx, aff))
  return { affiliationId: d.applied === 'none' ? null : aff.affiliationId, labelScopeRequested: requested, labelScopeApplied: d.applied, affiliationLabel: d.label }
}

// ── 토픽 목록·만들기 ──────────────────────────────────────────────────────

const CATEGORY_ORDER = new Map(TOPIC_CATEGORIES.map((c, i) => [c, i]))

/**
 * GET /community/topics — 플래그 꺼짐 404. active 기관 인증이 없으면 `eligible: false` + 빈 목록(토픽 이름도 보내지 않음).
 * active·보관된 토픽(제한된 토픽은 빼고), 분류 순 → 이름 순. 멤버 수·글 수는 없습니다.
 */
export async function listTopics(db: DbExecutor, actor: Actor): Promise<TopicListDto> {
  requireFeature('topics')
  const viewer = await loadViewer(db, actor)
  const eligible = viewer.status === 'active' && (viewer.affiliations.length > 0 || viewer.operator)
  if (!eligible) return { eligible: false, items: [] }
  const rows = await db
    .select()
    .from(communitySpaces)
    .where(and(eq(communitySpaces.kind, 'topic'), inArray(communitySpaces.status, ['active', 'archived'])))
  const items = rows
    .filter((r) => r.topicCategory !== null)
    .sort((a, b) => CATEGORY_ORDER.get(a.topicCategory!)! - CATEGORY_ORDER.get(b.topicCategory!)! || a.name.localeCompare(b.name, 'ko'))
    .map((r) => ({ slug: r.slug, name: r.name, description: r.description, category: r.topicCategory!, status: r.status }))
  return { eligible: viewer.affiliations.length > 0 || viewer.operator, items }
}

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const createTopicSchema = z.object({
  name: z.unknown(),
  description: z
    .string({ error: 'invalid' })
    .trim()
    .max(SPACE_DESCRIPTION_MAX, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v.normalize('NFC') : null)),
  category: z.enum(TOPIC_CATEGORIES, { error: requiredOr('invalid') }),
})

/**
 * POST /operator/community/topics {name, description?, category} — 운영자만(403 `operator_only`), 플래그 꺼짐 404. 201 + 상세.
 * 같은 이름 키(labelKey)의 토픽이 있으면 409 `topic_exists`(slug). 이름 예약어 검사는 하지 않습니다(운영자가 정함, 공식 페이지와 같음).
 * 감사 `community.topic_create{kind, category}`.
 */
export async function createTopic(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<SpaceDetailDto> {
  requireFeature('topics')
  await requireOperator(db, actor)
  const input = parseInput(createTopicSchema, rawInput)
  const checked = checkSpaceName(input.name, { reserved: false })
  if (!checked.ok) throw invalid({ name: checked.reason })
  const slug = await db.transaction(async (tx) => {
    const row = await insertTopicInTx(tx, { name: checked.value, description: input.description, category: input.category, createdBy: actor.userId }, now)
    await recordAudit(tx, { actorId: actor.userId, action: 'community.topic_create', targetType: 'community_space', targetId: row.id, metadata: { kind: 'topic', category: input.category } })
    await emitAnalytics(tx, { name: 'space_created', actorId: actor.userId, props: { kind: 'topic' }, now })
    return row.slug
  })
  return getSpaceDetail(db, actor, slug, now)
}

/** 토픽 행 + 기본 게시판(트랜잭션 안). 같은 이름 키가 있으면 409 `topic_exists`. 웹 API·테스트가 함께 씁니다(CLI는 같은 규칙을 SQL로). */
export async function insertTopicInTx(
  tx: DbExecutor,
  input: { name: string; description: string | null; category: (typeof TOPIC_CATEGORIES)[number]; createdBy: string },
  now: Date,
): Promise<typeof communitySpaces.$inferSelect> {
  // 같은 이름의 토픽을 동시에 만들지 않게 이름 키로 잠급니다(트랜잭션 advisory lock).
  const key = labelKey(input.name)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'topic:' + key}))`)
  const existing = await tx.select({ slug: communitySpaces.slug, name: communitySpaces.name }).from(communitySpaces).where(eq(communitySpaces.kind, 'topic'))
  const same = existing.find((e) => labelKey(e.name) === key)
  if (same) throw conflict('topic_exists', { slug: same.slug })
  return insertSpace(
    tx,
    {
      kind: 'topic',
      schoolId: null,
      name: input.name,
      description: input.description,
      nameMode: 'affiliated_anonymous',
      topicCategory: input.category,
      discovery: 'listed',
      joinPolicy: 'open',
      capacity: 100000,
      capacityRequested: null,
      createdBy: input.createdBy,
      ownerId: null,
      boards: TOPIC_DEFAULT_BOARDS,
    },
    now,
  )
}
