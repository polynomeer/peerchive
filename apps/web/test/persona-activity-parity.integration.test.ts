/**
 * ADR 0060 D-11: `persona_activity_cards`(migration 0031·0058의 SQL)와 도메인 `canReadSpace`가 같은 결과를 내는지 보는 표 기반 테스트(실제 PostgreSQL, rollback).
 *
 * 공간 종류·노출·상태 × 보는 사람(계정·인증·운영자 상태, 멤버십 상태)의 모든 칸에서: 기대값 = listed(투영 규칙 persona_activity_source_ok) AND canReadSpace.
 *
 * 일부러 표에서 뺀 것(규칙이 달라서가 아니라 함수로 판정할 수 없어서):
 * - 기관 운영진(isInstitutionStaffFor): 플래그 `institutions`가 켜졌을 때만 서버가 채우는 값이라 SQL은 플래그를 모릅니다. SQL은 카드를 내지 않습니다(더 좁은 쪽). 아래 테스트가 이 차이를 고정합니다.
 * - 토픽: 글이 소속 표시 익명으로 고정이라(community_spaces_topic_check) 실명·표시명 글이 없고 투영 자체가 생기지 않습니다.
 * - 졸업생 인증 이력(readsByAlumniHistory): canReadSpace가 아니라 게시판 단위 열람이며, 카드는 내지 않습니다.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canReadSpace } from '@peerchive/domain'
import {
  boards,
  communityPosts,
  communitySpaces,
  institutionAffiliations,
  institutionCohorts,
  operators,
  personaActivities,
  schools,
  spaceMemberships,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { createSchool } from '../server/modules/catalog/catalog'
import { loadSpaceContext, membershipFacts } from '../server/modules/community/access'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { createInstitution } from '../server/modules/institutions/institutions'
import { grantInstitutionStaff } from '../server/modules/institutions/staff'
import { closeTestDb, createUser, databaseUrl, insertRealProfile, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-04T09:00:00Z')
const ON = { PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'on' }
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

type Kind = 'official_school' | 'official_department' | 'user_room' | 'study_room'
type MembershipState = 'none' | 'active' | 'pending' | 'left' | 'removed'

interface SpaceCase {
  label: string
  kind: Kind
  school: 'S' | 'none' | 'T'
  cohort?: boolean
  discovery?: 'listed' | 'unlisted'
  status?: 'active' | 'archived' | 'restricted'
}

const SPACES: SpaceCase[] = [
  { label: '공식 학교', kind: 'official_school', school: 'S' },
  { label: '공식 학과', kind: 'official_department', school: 'S' },
  { label: '공식 학과(보관)', kind: 'official_department', school: 'S', status: 'archived' },
  { label: '기관 페이지', kind: 'official_school', school: 'T' },
  { label: '학교 방', kind: 'user_room', school: 'S' },
  { label: '학교 방(보관)', kind: 'user_room', school: 'S', status: 'archived' },
  { label: '학교 방(제한)', kind: 'user_room', school: 'S', status: 'restricted' },
  { label: '학교 방(비노출)', kind: 'user_room', school: 'S', discovery: 'unlisted' },
  { label: '학교 무관 방', kind: 'user_room', school: 'none' },
  { label: '기관 방', kind: 'user_room', school: 'T' },
  { label: '기수 방', kind: 'user_room', school: 'T', cohort: true },
  { label: '스터디 방', kind: 'study_room', school: 'S' },
  { label: '학교 무관 스터디 방', kind: 'study_room', school: 'none' },
]

interface ViewerCase {
  label: string
  membership: MembershipState
  /** 인증: S(그 학교), merged(S로 병합된 학교), other(다른 학교), T1(기관 + 이 방의 기수), T2(같은 기관 다른 기수), T(같은 기관 기수 없음), expired(S의 끝난 인증), 없음. */
  affiliation?: 'S' | 'merged' | 'other' | 'T1' | 'T2' | 'T' | 'expired'
  status?: 'active' | 'suspended' | 'deleted'
  operator?: boolean
}

const VIEWERS: ViewerCase[] = [
  { label: '인증 없음, 비멤버', membership: 'none' },
  { label: '인증 없음, 멤버', membership: 'active' },
  { label: '그 학교, 비멤버', membership: 'none', affiliation: 'S' },
  { label: '그 학교, 멤버', membership: 'active', affiliation: 'S' },
  { label: '그 학교, 승인 대기', membership: 'pending', affiliation: 'S' },
  { label: '그 학교, 나감', membership: 'left', affiliation: 'S' },
  { label: '그 학교, 내보내짐', membership: 'removed', affiliation: 'S' },
  { label: '병합된 학교, 멤버', membership: 'active', affiliation: 'merged' },
  { label: '다른 학교, 비멤버', membership: 'none', affiliation: 'other' },
  { label: '다른 학교, 멤버', membership: 'active', affiliation: 'other' },
  { label: '끝난 인증, 멤버', membership: 'active', affiliation: 'expired' },
  { label: '정지 계정, 멤버', membership: 'active', affiliation: 'S', status: 'suspended' },
  { label: '탈퇴 계정, 멤버', membership: 'active', affiliation: 'S', status: 'deleted' },
  { label: '운영자, 인증 없음, 비멤버', membership: 'none', operator: true },
  { label: '운영자, 그 학교, 멤버', membership: 'active', affiliation: 'S', operator: true },
  { label: '기관 이 기수, 비멤버', membership: 'none', affiliation: 'T1' },
  { label: '기관 이 기수, 멤버', membership: 'active', affiliation: 'T1' },
  { label: '기관 다른 기수, 멤버', membership: 'active', affiliation: 'T2' },
  { label: '기관 기수 없음, 멤버', membership: 'active', affiliation: 'T' },
]

async function cardIds(tx: DbExecutor, viewerId: string | null, ids: string[]): Promise<Set<string>> {
  const idArray = sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`
  const rows = (await tx.execute(sql`select activity_id from persona_activity_cards(${viewerId}::uuid, ${idArray})`)) as unknown as Array<{ activity_id: string }>
  return new Set(rows.map((r) => r.activity_id))
}

/** 학교·기관·공간·글·활동을 만듭니다. 글은 실명 방식이고 작성자의 실명 페르소나에 투영됩니다. */
async function world(tx: DbExecutor) {
  const op = await createUser(tx)
  await tx.insert(operators).values({ userId: op.id })
  const O = { userId: op.id }
  const S = await createSchool(tx, O, { name: `일치대${token()}학교`, confirmNew: true }, T0)
  const merged = await createSchool(tx, O, { name: `병합대${token()}학교`, confirmNew: true }, T0)
  await tx.update(schools).set({ mergedInto: S.id }).where(sql`${schools.id} = ${merged.id}`)
  const other = await createSchool(tx, O, { name: `남의대${token()}학교`, confirmNew: true }, T0)
  const T = await createInstitution(tx, O, { name: `일치캠프${token()}`, kind: 'bootcamp' }, T0)
  const cohort = async (label: string) => {
    const [row] = await tx.insert(institutionCohorts).values({ schoolId: T.id, label, labelKey: label }).returning({ id: institutionCohorts.id })
    return row!.id
  }
  const C1 = await cohort('1기')
  const C2 = await cohort('2기')

  const author = await createUser(tx, { displayName: '작성자' })
  const { personaId } = await insertRealProfile(tx, author.id, `p-${token()}`)
  const spaces = []
  for (const c of SPACES) {
    const schoolId = c.school === 'S' ? S.id : c.school === 'T' ? T.id : null
    const official = c.kind.startsWith('official_')
    const [space] = await tx
      .insert(communitySpaces)
      .values({
        kind: c.kind,
        schoolId,
        name: c.label,
        slug: token(),
        currentNameMode: official ? 'anonymous' : 'real',
        cohortId: c.cohort ? C1 : null,
        discovery: 'listed',
        joinPolicy: official ? 'open' : 'approval',
        createdBy: O.userId,
        ...(c.kind === 'official_department' && { departmentKey: token(), departmentLabel: '컴퓨터공학과' }),
      })
      .returning()
    const [board] = await tx.insert(boards).values({ spaceId: space!.id, kind: 'general', title: '일반', position: 0 }).returning({ id: boards.id })
    const [post] = await tx
      .insert(communityPosts)
      .values({ boardId: board!.id, spaceId: space!.id, authorId: author.id, nameMode: 'real', personaId, title: `글 ${c.label}`, body: '본문' })
      .returning({ id: communityPosts.id })
    const [activity] = await tx
      .insert(personaActivities)
      .values({ personaId, sourceType: 'community_post', sourceId: post!.id, itemKind: 'posts' })
      .returning({ id: personaActivities.id })
    // 투영 뒤에 바꿉니다(비노출은 트리거가 활동을 거둠, 상태는 읽기 판정에 영향이 없어야 함).
    if (c.discovery === 'unlisted') await tx.update(communitySpaces).set({ discovery: 'unlisted' }).where(sql`${communitySpaces.id} = ${space!.id}`)
    if (c.status === 'archived') await tx.update(communitySpaces).set({ status: 'archived', archivedAt: T0 }).where(sql`${communitySpaces.id} = ${space!.id}`)
    if (c.status === 'restricted') await tx.update(communitySpaces).set({ status: 'restricted', restrictedAt: T0 }).where(sql`${communitySpaces.id} = ${space!.id}`)
    spaces.push({ c, id: space!.id, activityId: activity!.id })
  }

  const viewers = []
  for (const v of VIEWERS) {
    const u = await createUser(tx, { displayName: v.label })
    const school = { S: S.id, merged: merged.id, other: other.id, T1: T.id, T2: T.id, T: T.id, expired: S.id }[v.affiliation ?? 'S']
    if (v.affiliation) {
      const { id } = await verifiedAffiliation(tx, u.id, school)
      if (v.affiliation === 'T1' || v.affiliation === 'T2') {
        await tx.update(institutionAffiliations).set({ cohortId: v.affiliation === 'T1' ? C1 : C2 }).where(sql`${institutionAffiliations.id} = ${id}`)
      }
      if (v.affiliation === 'expired') {
        await tx.update(institutionAffiliations).set({ status: 'expired', emailHash: null }).where(sql`${institutionAffiliations.id} = ${id}`)
      }
    }
    if (v.operator) await tx.insert(operators).values({ userId: u.id })
    if (v.membership !== 'none') {
      for (const s of spaces) {
        await tx.insert(spaceMemberships).values({
          spaceId: s.id,
          userId: u.id,
          status: v.membership,
          ...(v.membership === 'active' ? { joinedAt: T0 } : {}),
          ...(v.membership === 'pending' ? { requestedAt: T0 } : {}),
        })
      }
    }
    if (v.status && v.status !== 'active') await tx.update(users).set({ status: v.status }).where(sql`${users.id} = ${u.id}`)
    viewers.push({ v, userId: u.id })
  }
  return { O, T, spaces, viewers, ids: spaces.map((s) => s.activityId) }
}

describe.skipIf(!databaseUrl)('D-11 persona_activity_cards matches canReadSpace (PostgreSQL)', () => {
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))
  afterAll(closeTestDb)

  it('every space × viewer cell: a card comes back exactly when the space is listed and canReadSpace is true', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const disagreements: string[] = []
      for (const { v, userId } of w.viewers) {
        const cards = await cardIds(tx, userId, w.ids)
        for (const s of w.spaces) {
          const ctx = await loadSpaceContext(tx, { userId }, s.id, false, T0)
          const readable = canReadSpace(ctx.viewer, ctx.facts, membershipFacts(ctx.membership))
          const expected = (s.c.discovery ?? 'listed') === 'listed' && readable
          if (cards.has(s.activityId) !== expected) disagreements.push(`${s.c.label} × ${v.label}: SQL ${cards.has(s.activityId)}, 기대 ${expected}`)
        }
      }
      expect(disagreements).toEqual([])
      // 표가 양쪽을 모두 지나는지(모두 거짓으로 통과하지 않게).
      const member = w.viewers.find((x) => x.v.label === '그 학교, 멤버')!
      expect((await cardIds(tx, member.userId, w.ids)).size).toBeGreaterThan(3)
    })
  }, 240_000)

  it('a signed-out viewer gets no community card', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      expect((await cardIds(tx, null, w.ids)).size).toBe(0)
    })
  }, 240_000)

  it('known narrower case: institution staff read the page by canReadSpace, but the SQL (which cannot see the flag) returns no card', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const staff = { userId: (await createUser(tx)).id }
      await grantInstitutionStaff(tx, w.O, w.T.id, { userId: staff.userId }, T0)
      const page = w.spaces.find((s) => s.c.label === '기관 페이지')!
      const ctx = await loadSpaceContext(tx, staff, page.id, false, T0)
      expect(canReadSpace(ctx.viewer, ctx.facts, membershipFacts(ctx.membership))).toBe(true)
      expect((await cardIds(tx, staff.userId, [page.activityId])).size).toBe(0)
    })
  }, 240_000)
})
