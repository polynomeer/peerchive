/**
 * A-05 토픽·소속 표시 익명·임계값 통합 테스트(DELIVERY_PLAN §4.3 A-05·§5.3 Y·§7 GA 게이트, SYSTEM_DESIGN §6.7.2·§8.4, ADR 0042).
 * - 시나리오 Y 전체: 30명 부트캠프 → 넓힘, 60명 대학 졸업생 → 기관 이름, 표시 안 함 → 없음, 이후 회원 증가·소속 변경에도 표시 그대로,
 *   학과·기수 미표시, 넓혀졌는지는 작성자에게만.
 * - 임계값을 세는 회원(인증된 active 소속·같은 신분·active 계정·정본 기관), 토픽 접근(기관 인증·운영자 읽기만·플래그),
 *   DB 불변식(persona null·토픽 밖 금지·고정 열·투영 거부), 운영자 작성자 확인.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 기관·사용자만 봅니다.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { institutionNameKey } from '@peerchive/domain'
import {
  communityComments,
  communityPosts,
  eq,
  institutionAffiliations,
  operators,
  outboxEvents,
  personaActivities,
  schools,
  sql,
  users,
  and,
  type DbExecutor,
} from '@peerchive/db'
import { createOfficialPage } from '../server/modules/community/official'
import { lookupAuthor, operatorCommunityItem } from '../server/modules/community/moderation'
import { scheduleNameModeChange } from '../server/modules/community/name-modes'
import { createComment, createPost, editPost, getPost, listBoardPosts, setReaction } from '../server/modules/community/posts'
import { createRoom, getSpaceDetail, listMySpaces } from '../server/modules/community/spaces'
import { createTopic, listTopics, verifiedCategoryCount, verifiedMemberCount } from '../server/modules/community/topics'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { projectPersonaActivity } from '../server/modules/social/activities'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertRealProfile, testDb } from './helpers'

class Rollback extends Error {}
/** rollback 트랜잭션(helpers.withRollback과 같음). 실패한 단언은 감싸지 않고 그대로 보여 줍니다. */
async function withRollback(fn: (tx: DbExecutor) => Promise<void>): Promise<void> {
  const error = await testDb()
    .transaction(async (tx) => {
      await fn(tx)
      throw new Rollback()
    })
    .catch((e: unknown) => e)
  if (!(error instanceof Rollback)) throw error
}

const T0 = new Date('2026-11-12T03:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const ON = { PEERCHIVE_FEATURE_P2_TOPICS: 'on' }
const VERIFIED = new Date('2026-03-02T00:00:00Z')

type Kind = 'university' | 'bootcamp' | 'training_program'
type Standing = 'student' | 'alumni'

async function institution(tx: DbExecutor, kind: Kind, name: string, mergedInto: string | null = null) {
  const unique = `${name}${crypto.randomUUID().slice(0, 6)}`
  const [row] = await tx
    .insert(schools)
    .values({ name: unique, nameKey: institutionNameKey(unique), kind, mergedInto, mergedAt: mergedInto ? T0 : null })
    .returning({ id: schools.id, name: schools.name })
  return row!
}

/** 한 기관에 사람 n명과 소속을 한 번에 넣습니다(대학은 메일, 그 밖은 초대 코드 수단). 반환: 사용자 id들. */
async function members(
  tx: DbExecutor,
  schoolId: string,
  kind: Kind,
  n: number,
  o: { standing?: Standing; status?: 'active' | 'pending' | 'revoked' | 'expired'; verified?: boolean; account?: 'active' | 'suspended' | 'deleted'; departmentLabel?: string } = {},
): Promise<string[]> {
  if (n === 0) return []
  const rows = await tx
    .insert(users)
    .values(Array.from({ length: n }, (_, i) => ({ displayName: `회원${i}`, privateEmail: `m${i}+${crypto.randomUUID()}@example.test`, status: o.account ?? 'active' })))
    .returning({ id: users.id })
  const status = o.status ?? 'active'
  const verified = o.verified ?? status !== 'pending'
  await tx.insert(institutionAffiliations).values(
    rows.map((r) => ({
      userId: r.id,
      schoolId,
      institutionKind: kind,
      method: kind === 'university' ? ('email' as const) : ('invite_code' as const),
      emailHash: kind === 'university' && (status === 'active' || status === 'pending') ? crypto.randomUUID().replace(/-/g, '').repeat(2) : null,
      emailDomain: kind === 'university' ? 'fixture.ac.kr' : null,
      standing: o.standing ?? 'alumni',
      departmentLabel: o.departmentLabel ?? null,
      status,
      verifiedAt: verified ? VERIFIED : null,
      ...(status === 'revoked' && { revokedAt: T0, revokedReason: 'user_removed' }),
    })),
  )
  return rows.map((r) => r.id)
}

/**
 * 넓힌 범주(기관 종류, 신분 — 모든 기관 합계)의 인증 회원이 적어도 n명이 되게 다른 기관에 회원을 채웁니다(개발 DB에 남은 다른 데이터와 무관하게).
 * 두 단계 임계값(ADR 0042 §4)에서 범주 단계가 표시를 없애지 않게 하는 시나리오용.
 */
async function categoryAtLeast(tx: DbExecutor, kind: Kind, standing: Standing, n: number): Promise<void> {
  const have = await verifiedCategoryCount(tx, kind, standing)
  if (have >= n) return
  const filler = await institution(tx, kind, '채움기관')
  await members(tx, filler.id, kind, n - have, { standing })
}

async function operator(tx: DbExecutor) {
  const op = await createUser(tx, { displayName: '운영자' })
  await tx.insert(operators).values({ userId: op.id })
  return { userId: op.id }
}

async function topic(tx: DbExecutor, op: { userId: string }, name = `취준 ${crypto.randomUUID().slice(0, 6)}`) {
  const t = await createTopic(tx, op, { name, category: 'career', description: '취업 준비 이야기' }, T0)
  return { slug: t.slug, boardId: t.boards[0]!.id }
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

async function failsWith(tx: DbExecutor, fn: (inner: DbExecutor) => Promise<unknown>): Promise<string | undefined> {
  try {
    await tx.transaction(async (sp) => {
      await fn(sp)
    })
    return undefined
  } catch (error) {
    return pgCode(error) ?? String(error)
  }
}

describe.skipIf(!databaseUrl)('A-05 topics and affiliation labels (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('scenario Y: 30-member bootcamp → 부트캠프 수료생 (broadened, told only to the author), 60 university graduates → ○○대 · 졸업생, 표시 안 함 → none, later growth/changes keep labels, department/cohort never shown', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const t = await topic(tx, op, '취준')
      const camp = await institution(tx, 'bootcamp', '코드런부트캠프')
      const univ = await institution(tx, 'university', '한빛대학교')
      const [A] = await members(tx, camp.id, 'bootcamp', 1, { departmentLabel: '백엔드반' })
      await members(tx, camp.id, 'bootcamp', 29)
      const [C] = await members(tx, univ.id, 'university', 1, { departmentLabel: '컴퓨터공학과' })
      await members(tx, univ.id, 'university', 59)
      // 범주(부트캠프 수료생 전체)는 50명 이상이라 두 번째 단계가 표시를 없애지 않습니다.
      await categoryAtLeast(tx, 'bootcamp', 'alumni', 50)
      const a = { userId: A! }
      const c = { userId: C! }

      // 글쓰기 화면: 작성자 자신의 소속 미리보기만, 회원 수 없이. A(30명)는 넓혀짐, C(60명)는 기관 이름.
      const aComposer = (await listBoardPosts(tx, a, t.boardId, {}, at(1))).composer
      expect(aComposer.nameMode).toBe('affiliated_anonymous')
      expect(aComposer.choices).toEqual(['affiliated_anonymous'])
      expect(aComposer.affiliation!.options).toHaveLength(1)
      expect(aComposer.affiliation!.options[0]!.previews).toEqual({
        institution: { label: '부트캠프 수료생', broadened: true },
        institution_kind: { label: '부트캠프 수료생', broadened: false },
        none: { label: null, broadened: false },
      })
      const cComposer = (await listBoardPosts(tx, c, t.boardId, {}, at(1))).composer
      expect(cComposer.affiliation!.options[0]!.previews.institution).toEqual({ label: `${univ.name} · 졸업생`, broadened: false })

      const aPost = await createPost(tx, a, t.boardId, { title: '부트캠프 수료 후 취준', body: '포트폴리오 어떻게 하나요' }, at(2))
      expect(aPost.nameMode).toBe('affiliated_anonymous')
      expect(aPost.affiliationLabel).toBe('부트캠프 수료생')
      expect(aPost.labelBroadened).toBe(true)
      expect(aPost.author).toMatchObject({ kind: 'anonymous', label: '글쓴이', mine: true })

      const cPost = await createPost(tx, c, t.boardId, { title: '졸업생 취준', body: '면접 후기' }, at(3))
      expect(cPost.affiliationLabel).toBe(`${univ.name} · 졸업생`)
      expect(cPost.labelBroadened).toBe(false)
      const cHidden = await createPost(tx, c, t.boardId, { title: '표시 안 함', body: '조용히', affiliationScope: 'none' }, at(4))
      expect(cHidden.affiliationLabel).toBeNull()
      const cKind = await createPost(tx, c, t.boardId, { title: '유형만', body: '대학만', affiliationScope: 'institution_kind' }, at(5))
      expect(cKind.affiliationLabel).toBe('대학 졸업생')
      expect(cKind.labelBroadened).toBe(false)

      // 다른 사람에게는 문자열만: 넓혀졌는지 키가 없음. 작성자 본인 응답에만 있음.
      const aSeenByC = await getPost(tx, c, aPost.id, at(6))
      expect(aSeenByC.affiliationLabel).toBe('부트캠프 수료생')
      expect('labelBroadened' in aSeenByC).toBe(false)
      expect(aSeenByC.author).toMatchObject({ kind: 'anonymous', label: '글쓴이', mine: false })
      const listByC = await listBoardPosts(tx, c, t.boardId, {}, at(6))
      const aItemForC = listByC.items.find((i) => i.id === aPost.id)!
      expect(aItemForC.affiliationLabel).toBe('부트캠프 수료생')
      expect('labelBroadened' in aItemForC).toBe(false)
      expect((await listBoardPosts(tx, a, t.boardId, {}, at(6))).items.find((i) => i.id === aPost.id)!.labelBroadened).toBe(true)

      // 댓글도 같은 규칙(스레드 번호 + 고정된 소속 표시).
      const thread = await createComment(tx, c, aPost.id, { body: '저도 궁금해요' }, at(7))
      const cComment = thread.comments.at(-1)!
      expect(cComment.author.label).toBe('익명1')
      expect(cComment.affiliationLabel).toBe(`${univ.name} · 졸업생`)
      // C 자신의 응답이라 C의 댓글에는 넓혀졌는지(false)가 있고, 글쓴이 A의 눈에는 키가 없습니다.
      expect(cComment.labelBroadened).toBe(false)
      expect('labelBroadened' in (await getPost(tx, a, aPost.id, at(7))).comments.at(-1)!).toBe(false)
      const own = await createComment(tx, a, aPost.id, { body: '작성자 답글', affiliationScope: 'none' }, at(8))
      expect(own.comments.at(-1)).toMatchObject({ author: { label: '글쓴이' }, affiliationLabel: null, labelBroadened: false })

      // 학과·기수는 어디에도 없음(작성자·다른 사람의 글·목록·글쓰기 화면).
      const everything = JSON.stringify([
        await getPost(tx, a, aPost.id, at(9)),
        await getPost(tx, c, cPost.id, at(9)),
        await listBoardPosts(tx, a, t.boardId, {}, at(9)),
        await listBoardPosts(tx, c, t.boardId, {}, at(9)),
      ])
      for (const secret of ['백엔드반', '컴퓨터공학과', A!, C!]) expect(everything.includes(secret), secret).toBe(false)
      // 회원 수·소속 id는 응답에 없음(작성자 본인 글쓰기 화면의 자기 소속 id만 예외).
      expect(everything.includes('verifiedMembers')).toBe(false)

      // 이후 회원 증가(30 → 55)·소속 변경(C의 인증 해제): 이미 쓴 글의 표시는 그대로, 새 글만 새 값.
      await members(tx, camp.id, 'bootcamp', 25)
      expect(await verifiedMemberCount(tx, camp.id, 'alumni')).toBe(55)
      expect((await getPost(tx, a, aPost.id, at(10))).affiliationLabel).toBe('부트캠프 수료생')
      const aLater = await createPost(tx, a, t.boardId, { title: '이제는', body: '기관 이름' }, at(11))
      expect(aLater.affiliationLabel).toBe(`${camp.name} · 수료생`)
      expect(aLater.labelBroadened).toBe(false)
      await tx.update(institutionAffiliations).set({ status: 'revoked', revokedAt: at(12), revokedReason: 'user_removed', emailHash: null }).where(eq(institutionAffiliations.userId, C!))
      expect((await getPost(tx, a, cPost.id, at(13))).affiliationLabel).toBe(`${univ.name} · 졸업생`)
      // 인증이 끊긴 C는 다음 요청부터 토픽을 읽지도 쓰지도 못함(404).
      await expectServiceError(getPost(tx, c, cPost.id, at(13)), 'NOT_FOUND')
      await expectServiceError(createPost(tx, c, t.boardId, { title: 'x', body: 'y' }, at(13)), 'NOT_FOUND')

      // 고친 글도 표시는 그대로(고정 열).
      const edited = await editPost(tx, a, aPost.id, { body: '고친 본문', expectedVersion: 1 }, at(14))
      expect(edited.affiliationLabel).toBe('부트캠프 수료생')
      expect(edited.labelBroadened).toBe(true)

      // 행: 소속 id(운영자 전용)·고른 범위·적용 범위·문자열. 표시 안 함이면 소속 id 없음. 페르소나 없음.
      const [aRow] = await tx.select().from(communityPosts).where(eq(communityPosts.id, aPost.id))
      expect(aRow).toMatchObject({ personaId: null, labelScopeRequested: 'institution', labelScopeApplied: 'institution_kind', affiliationLabel: '부트캠프 수료생' })
      expect(aRow!.affiliationId).not.toBeNull()
      const [hiddenRow] = await tx.select().from(communityPosts).where(eq(communityPosts.id, cHidden.id))
      expect(hiddenRow).toMatchObject({ affiliationId: null, labelScopeRequested: 'none', labelScopeApplied: 'none', affiliationLabel: null })
    })
  })

  it('the threshold counts only verified, active affiliations of that standing at the canonical institution, of active accounts, once per person', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const t = await topic(tx, op)
      const univ = await institution(tx, 'university', '세는대학교')
      const merged = await institution(tx, 'university', '병합된대학교', univ.id)
      const [author] = await members(tx, univ.id, 'university', 1, { standing: 'alumni' })
      await members(tx, univ.id, 'university', 47, { standing: 'alumni' })
      // 세지 않는 것: 다른 신분, 대기·철회·만료, 인증 안 됨, 정지·탈퇴 계정, 다른 기관.
      await members(tx, univ.id, 'university', 10, { standing: 'student' })
      await members(tx, univ.id, 'university', 3, { status: 'pending' })
      await members(tx, univ.id, 'university', 3, { status: 'revoked' })
      await members(tx, univ.id, 'university', 3, { status: 'expired' })
      await members(tx, univ.id, 'university', 3, { account: 'suspended' })
      await members(tx, univ.id, 'university', 3, { account: 'deleted' })
      const other = await institution(tx, 'university', '다른대학교')
      await members(tx, other.id, 'university', 60)
      await categoryAtLeast(tx, 'university', 'student', 50)
      // 병합된 학교의 졸업생 1명은 정본 기관으로 셈(48 + 1 = 49 < 50).
      await members(tx, merged.id, 'university', 1, { standing: 'alumni' })
      expect(await verifiedMemberCount(tx, univ.id, 'alumni')).toBe(49)
      const a = { userId: author! }
      const before = await createPost(tx, a, t.boardId, { title: '49명', body: '넓힘' }, at(1))
      expect(before).toMatchObject({ affiliationLabel: '대학 졸업생', labelBroadened: true })
      // 같은 사람이 병합 전 학교에도 active 소속이 있어도 한 번만 셈.
      await tx.insert(institutionAffiliations).values({
        userId: author!,
        schoolId: merged.id,
        emailHash: crypto.randomUUID().replace(/-/g, '').repeat(2),
        emailDomain: 'fixture.ac.kr',
        standing: 'alumni',
        status: 'active',
        verifiedAt: VERIFIED,
      })
      expect(await verifiedMemberCount(tx, univ.id, 'alumni')).toBe(49)
      await members(tx, univ.id, 'university', 1, { standing: 'alumni' })
      expect(await verifiedMemberCount(tx, univ.id, 'alumni')).toBe(50)
      const after = await createPost(tx, a, t.boardId, { title: '50명', body: '이름', affiliationId: (await tx.select().from(institutionAffiliations).where(and(eq(institutionAffiliations.userId, author!), eq(institutionAffiliations.schoolId, univ.id))))[0]!.id }, at(2))
      expect(after).toMatchObject({ affiliationLabel: `${univ.name} · 졸업생`, labelBroadened: false })
      // 재학생 신분은 따로 셈(10명 → 넓힘). 정본 기관 이름으로 표시(병합된 학교의 소속도 정본 이름).
      const [student] = await members(tx, merged.id, 'university', 1, { standing: 'student' })
      const s = await createPost(tx, { userId: student! }, t.boardId, { title: '재학생', body: '넓힘' }, at(3))
      expect(s.affiliationLabel).toBe('대학 재학생')
      expect(await verifiedMemberCount(tx, univ.id, 'student')).toBe(11)
    })
  })

  it('second step: a rare kind whose whole category (kind + standing) has < 50 verified members shows no label; the author is told, others only see none; growth past 50 shows the category for new posts only', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const t = await topic(tx, op)
      const baseline = await verifiedCategoryCount(tx, 'training_program', 'alumni')
      expect(baseline, '개발 DB에 교육 프로그램 수료생이 이미 49명 이상이면 이 시나리오를 만들 수 없습니다').toBeLessThan(40)
      const prog = await institution(tx, 'training_program', '희귀교육과정')
      const [author] = await members(tx, prog.id, 'training_program', 1)
      await members(tx, prog.id, 'training_program', 9)
      // 다른 교육 프로그램들을 합쳐도 범주가 49명(기관 10명, 범주 49명).
      const other = await institution(tx, 'training_program', '다른교육과정')
      await members(tx, other.id, 'training_program', 49 - baseline - 10)
      // 세지 않는 것은 범주에도 세지 않음: 다른 신분·대기·정지 계정·다른 종류.
      await members(tx, other.id, 'training_program', 5, { standing: 'student' })
      await members(tx, other.id, 'training_program', 5, { status: 'pending' })
      await members(tx, other.id, 'training_program', 5, { account: 'suspended' })
      const camp = await institution(tx, 'bootcamp', '종류다른부트캠프')
      await members(tx, camp.id, 'bootcamp', 5)
      expect(await verifiedMemberCount(tx, prog.id, 'alumni')).toBe(10)
      expect(await verifiedCategoryCount(tx, 'training_program', 'alumni')).toBe(49)
      const a = { userId: author! }

      // 글쓰기 미리보기(나에게만): 기관 이름·유형 모두 표시 없음 + 넓혀짐.
      const composer = (await listBoardPosts(tx, a, t.boardId, {}, at(1))).composer.affiliation!
      expect(composer.options[0]!.previews).toEqual({
        institution: { label: null, broadened: true },
        institution_kind: { label: null, broadened: true },
        none: { label: null, broadened: false },
      })
      const byName = await createPost(tx, a, t.boardId, { title: '희귀 과정', body: '이름 골랐지만' }, at(2))
      expect(byName).toMatchObject({ affiliationLabel: null, labelBroadened: true })
      const byKind = await createPost(tx, a, t.boardId, { title: '희귀 과정 2', body: '유형 골랐지만', affiliationScope: 'institution_kind' }, at(3))
      expect(byKind).toMatchObject({ affiliationLabel: null, labelBroadened: true })
      const [row] = await tx.select().from(communityPosts).where(eq(communityPosts.id, byName.id))
      expect(row).toMatchObject({ labelScopeRequested: 'institution', labelScopeApplied: 'none', affiliationLabel: null, affiliationId: null })
      const [kindRow] = await tx.select().from(communityPosts).where(eq(communityPosts.id, byKind.id))
      expect(kindRow).toMatchObject({ labelScopeRequested: 'institution_kind', labelScopeApplied: 'none' })
      // 다른 사람에게는 소속 표시 없음과 같고, 넓혀졌는지는 없음.
      const [peer] = await members(tx, camp.id, 'bootcamp', 1)
      const seen = await getPost(tx, { userId: peer! }, byName.id, at(4))
      expect(seen.affiliationLabel).toBeNull()
      expect('labelBroadened' in seen).toBe(false)
      // 댓글도 같은 두 단계.
      const thread = await createComment(tx, a, byName.id, { body: '글쓴이 댓글', affiliationScope: 'institution_kind' }, at(5))
      expect(thread.comments.at(-1)).toMatchObject({ affiliationLabel: null, labelBroadened: true })

      // 범주가 50명이 되면 새 글은 유형 글자(기관은 여전히 10명이라 넓혀짐), 이미 쓴 글은 그대로 표시 없음.
      await members(tx, other.id, 'training_program', 1)
      const later = await createPost(tx, a, t.boardId, { title: '이제는', body: '유형' }, at(6))
      expect(later).toMatchObject({ affiliationLabel: '교육 프로그램 수료생', labelBroadened: true })
      expect((await getPost(tx, a, byName.id, at(7))).affiliationLabel).toBeNull()
    })
  })

  it('access: any active affiliation reads/writes; none → eligible false and 404; operators read only; label input outside topics or for someone else’s affiliation is 422', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const t = await topic(tx, op)
      const camp = await institution(tx, 'bootcamp', '접근부트캠프')
      const [member] = await members(tx, camp.id, 'bootcamp', 1, { standing: 'student' })
      const [stranger] = await members(tx, camp.id, 'bootcamp', 1, { status: 'expired' })
      const m = { userId: member! }
      const x = { userId: stranger! }
      expect((await listTopics(tx, m)).items.map((i) => i.slug)).toContain(t.slug)
      expect(await listTopics(tx, x)).toEqual({ eligible: false, items: [] })
      await expectServiceError(getSpaceDetail(tx, x, t.slug, at(1)), 'NOT_FOUND')
      await expectServiceError(listBoardPosts(tx, x, t.boardId, {}, at(1)), 'NOT_FOUND')

      const detail = await getSpaceDetail(tx, m, t.slug, at(1))
      expect(detail).toMatchObject({ kind: 'topic', official: false, nameMode: 'affiliated_anonymous', memberCount: null, joinAction: 'none', access: 'member' })
      expect(detail.permissions).toMatchObject({ manage: false, moderate: false, invite: false, changeNameMode: false })
      // 토픽은 내 공간 목록(가입한 방·내 학교 공식 페이지)에 섞이지 않습니다.
      expect((await listMySpaces(tx, m)).items.some((s) => s.slug === t.slug)).toBe(false)

      // 운영자(기관 인증 없음): 읽기·운영만, 쓰기 화면 없음.
      const opView = await listBoardPosts(tx, op, t.boardId, {}, at(1))
      expect(opView.composer.canWrite).toBe(false)
      expect(opView.composer.affiliation).toBeUndefined()
      expect((await getSpaceDetail(tx, op, t.slug, at(1))).permissions.moderate).toBe(true)
      await expectServiceError(createPost(tx, op, t.boardId, { title: 'x', body: 'y' }, at(1)), 'FORBIDDEN', 'write_not_allowed')

      // 이름 표시 방식은 토픽 방식만, 소속 id는 내 active 소속만.
      await expectServiceError(createPost(tx, m, t.boardId, { title: 'x', body: 'y', nameMode: 'anonymous' }, at(2)), 'VALIDATION')
      const [otherAff] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.userId, stranger!))
      const wrong = await expectServiceError(createPost(tx, m, t.boardId, { title: 'x', body: 'y', affiliationId: otherAff!.id }, at(2)), 'VALIDATION')
      expect(wrong.fields).toEqual({ affiliationId: 'invalid' })
      const bad = await expectServiceError(createPost(tx, m, t.boardId, { title: 'x', body: 'y', affiliationScope: 'everything' }, at(2)), 'VALIDATION')
      expect(bad.fields).toMatchObject({ affiliationScope: 'invalid' })
      const none = await expectServiceError(createPost(tx, m, t.boardId, { title: 'x', body: 'y', affiliationScope: 'none', affiliationId: (await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.userId, member!)))[0]!.id }, at(2)), 'VALIDATION')
      expect(none.fields).toEqual({ affiliationId: 'not_applicable' })

      // 토픽이 아닌 공간: 소속 표시 입력과 affiliated_anonymous는 422.
      const room = await createRoom(tx, m, { name: `방 ${crypto.randomUUID().slice(0, 4)}`, nameMode: 'anonymous', joinPolicy: 'open' }, at(3))
      const outside = await expectServiceError(createPost(tx, m, room.boards[0]!.id, { title: 'x', body: 'y', affiliationScope: 'institution' }, at(3)), 'VALIDATION')
      expect(outside.fields).toEqual({ affiliationScope: 'not_allowed' })
      const roomMode = await expectServiceError(createPost(tx, m, room.boards[0]!.id, { title: 'x', body: 'y', nameMode: 'affiliated_anonymous' }, at(3)), 'VALIDATION')
      expect(roomMode.fields).toEqual({ nameMode: 'mode_fixed' })

      // 공감은 됨(자기 글 제외), 시각은 정확한 값(토픽은 멤버 수를 세지 않는 넓은 공간).
      const p = await createPost(tx, m, t.boardId, { title: '공감', body: '해 주세요' }, at(4))
      expect(p.createdAt).toBe(at(4).toISOString())
      const [peer] = await members(tx, camp.id, 'bootcamp', 1)
      expect(await setReaction(tx, { userId: peer! }, 'post', p.id, true, at(5))).toEqual({ count: 1, reacted: true })
      // 토픽 글에는 라운지 미디어가 없습니다(ADR 0042).
      expect(p.lounge).toBeUndefined()
    })
  })

  it('DB: affiliated_anonymous has no persona (check), lives only in topics (trigger), labels are frozen and never narrower than chosen, and is never projected', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const t = await topic(tx, op)
      const univ = await institution(tx, 'university', '불변대학교')
      const [u] = await members(tx, univ.id, 'university', 1)
      const { personaId } = await insertRealProfile(tx, u!, `r-${crypto.randomUUID().slice(0, 10)}`)
      const post = await createPost(tx, { userId: u! }, t.boardId, { title: '토픽', body: '본문' }, at(1))
      const [row] = await tx.select().from(communityPosts).where(eq(communityPosts.id, post.id))
      expect(row!.personaId).toBeNull()
      // 페르소나 활동 투영 요청(outbox)도 만들지 않음.
      const events = await tx.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'sourceId' = ${post.id}`)
      expect(events).toEqual([])

      const label = { nameMode: 'affiliated_anonymous' as const, labelScopeRequested: 'institution' as const, labelScopeApplied: 'institution_kind' as const, affiliationLabel: '대학 졸업생' }
      const base = { boardId: t.boardId, spaceId: row!.spaceId, authorId: u!, title: 't', body: 'b' }
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, personaId }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(communityComments).values({ postId: post.id, authorId: u!, body: 'c', ...label, personaId }))).toBe('23514')
      // 토픽 밖(사용자 방)에는 소속 표시 익명 글·댓글을 넣을 수 없음.
      const room = await createRoom(tx, { userId: u! }, { name: `불변 방 ${crypto.randomUUID().slice(0, 4)}`, nameMode: 'anonymous', joinPolicy: 'open' }, at(2))
      const roomPost = await createPost(tx, { userId: u! }, room.boards[0]!.id, { title: '방 글', body: '방' }, at(2))
      const [roomRow] = await tx.select().from(communityPosts).where(eq(communityPosts.id, roomPost.id))
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, boardId: room.boards[0]!.id, spaceId: roomRow!.spaceId, ...label }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(communityComments).values({ postId: roomPost.id, authorId: u!, body: 'c', ...label }))).toBe('23514')
      // 범위가 고른 것보다 좁으면·표시 안 함인데 문자열이 있으면·다른 방식에 소속 열이 있으면 check 위반.
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, labelScopeRequested: 'institution_kind', labelScopeApplied: 'institution' }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, labelScopeRequested: 'none', labelScopeApplied: 'institution_kind' }))).toBe('23514')
      // 두 단계 임계값: 고른 범위에서 표시 안 함으로 넓히는 것은 허용(문자열 없이).
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, labelScopeRequested: 'institution_kind', labelScopeApplied: 'none', affiliationLabel: null }))).toBeUndefined()
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, labelScopeRequested: 'institution', labelScopeApplied: 'none', affiliationLabel: null }))).toBeUndefined()
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, labelScopeRequested: 'institution', labelScopeApplied: 'none' }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, labelScopeRequested: 'none', labelScopeApplied: 'none' }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, ...label, labelScopeRequested: null, labelScopeApplied: null }))).toBe('23514')
      expect(
        await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, boardId: room.boards[0]!.id, spaceId: roomRow!.spaceId, nameMode: 'anonymous', affiliationLabel: '대학 졸업생' })),
      ).toBe('23514')
      // 고정 열: 표시 문자열·범위는 바꿀 수 없고, 소속 id는 비우기만.
      expect(await failsWith(tx, (i) => i.update(communityPosts).set({ affiliationLabel: '한빛대 · 졸업생' }).where(eq(communityPosts.id, post.id)))).toBe('23514')
      expect(await failsWith(tx, (i) => i.update(communityPosts).set({ labelScopeApplied: 'institution' }).where(eq(communityPosts.id, post.id)))).toBe('23514')
      const [other] = await members(tx, univ.id, 'university', 1)
      const [otherAff] = await tx.select({ id: institutionAffiliations.id }).from(institutionAffiliations).where(eq(institutionAffiliations.userId, other!))
      expect(await failsWith(tx, (i) => i.update(communityPosts).set({ affiliationId: otherAff!.id }).where(eq(communityPosts.id, post.id)))).toBe('23514')
      expect(await failsWith(tx, (i) => i.update(communityPosts).set({ affiliationId: null }).where(eq(communityPosts.id, post.id)))).toBeUndefined()

      // 투영: 규칙이 anonymous로 거부하고, 사실을 속여도·원시 SQL로 넣어도 DB가 거부.
      const facts = { type: 'community_post' as const, nameMode: 'affiliated_anonymous' as const, personaId: null, discovery: 'listed' as const, published: true }
      expect(await projectPersonaActivity(tx, { personaId, sourceId: post.id, source: facts, occurredAt: at(1) })).toEqual({ projected: false, reason: 'anonymous' })
      const lie = { ...facts, nameMode: 'real' as const, personaId }
      expect(await failsWith(tx, (i) => projectPersonaActivity(i, { personaId, sourceId: post.id, source: lie, occurredAt: at(1) }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(personaActivities).values({ personaId, sourceType: 'community_post', sourceId: post.id, itemKind: 'posts' }))).toBe('23514')
    })
  })

  it('operators: author lookup returns the operator-only affiliation id; the report view shows the label; no audit row names the affiliation', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const t = await topic(tx, op)
      const camp = await institution(tx, 'bootcamp', '운영부트캠프')
      const [u] = await members(tx, camp.id, 'bootcamp', 1)
      await categoryAtLeast(tx, 'bootcamp', 'alumni', 50)
      const post = await createPost(tx, { userId: u! }, t.boardId, { title: '신고될 글', body: '본문' }, at(1))
      const item = await operatorCommunityItem(tx, { postId: post.id, commentId: null })
      expect(item).toMatchObject({ nameMode: 'affiliated_anonymous', authorLabel: '익명', affiliationLabel: '부트캠프 수료생' })
      const [aff] = await tx.select({ id: institutionAffiliations.id }).from(institutionAffiliations).where(eq(institutionAffiliations.userId, u!))
      const found = await lookupAuthor(tx, op, { targetType: 'post', targetId: post.id, reason: '신고 처리' }, at(2))
      expect(found.author.userId).toBe(u)
      expect(found.affiliationId).toBe(aff!.id)
      const audits = (await tx.execute(sql`select metadata::text as m from audit_events where at >= now() - interval '1 minute'`)) as unknown as Array<{ m: string }>
      for (const a of audits) {
        expect(a.m.includes(aff!.id)).toBe(false)
        expect(a.m.includes('부트캠프 수료생')).toBe(false)
      }
    })
  })

  it('flag off: topic list/create and every topic route are 404; affiliated_anonymous is rejected everywhere else', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const t = await topic(tx, op)
      const univ = await institution(tx, 'university', '꺼짐대학교')
      const [u] = await members(tx, univ.id, 'university', 1)
      const a = { userId: u! }
      const post = await createPost(tx, a, t.boardId, { title: '켜졌을 때', body: '쓴 글' }, at(1))
      setFeatureEnvForTesting(null)
      await expectServiceError(listTopics(tx, a), 'NOT_FOUND')
      await expectServiceError(createTopic(tx, op, { name: '꺼짐', category: 'career' }, at(2)), 'NOT_FOUND')
      await expectServiceError(getSpaceDetail(tx, a, t.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(getSpaceDetail(tx, op, t.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(listBoardPosts(tx, a, t.boardId, {}, at(2)), 'NOT_FOUND')
      await expectServiceError(getPost(tx, a, post.id, at(2)), 'NOT_FOUND')
      await expectServiceError(createPost(tx, a, t.boardId, { title: 'x', body: 'y' }, at(2)), 'NOT_FOUND')
      await expectServiceError(createComment(tx, a, post.id, { body: 'z' }, at(2)), 'NOT_FOUND')
      await expectServiceError(setReaction(tx, a, 'post', post.id, true, at(2)), 'NOT_FOUND')
      // 공식 페이지·방에서 소속 표시 익명을 고르면 422(플래그와 무관하게 토픽 전용).
      const official = await createOfficialPage(tx, op, { schoolId: univ.id }, at(2))
      const free = official.boards.find((b) => b.kind === 'free')!
      const e1 = await expectServiceError(createPost(tx, a, free.id, { title: 'x', body: 'y', nameMode: 'affiliated_anonymous' }, at(3)), 'VALIDATION')
      expect(e1.fields).toEqual({ nameMode: 'affiliated_not_allowed' })
      const e2 = await expectServiceError(createRoom(tx, a, { name: '소속방', nameMode: 'affiliated_anonymous' }, at(3)), 'VALIDATION')
      expect(e2.fields).toMatchObject({ nameMode: 'invalid' })
      const room = await createRoom(tx, a, { name: `바꿀 방 ${crypto.randomUUID().slice(0, 4)}`, nameMode: 'anonymous', joinPolicy: 'open' }, at(3))
      await expectServiceError(scheduleNameModeChange(tx, a, room.slug, { toMode: 'affiliated_anonymous' }, at(3)), 'VALIDATION')
      // 다시 켜면 그대로 보입니다(행은 남음).
      setFeatureEnvForTesting(ON)
      expect((await getPost(tx, a, post.id, at(4))).affiliationLabel).toBe(post.affiliationLabel)
    })
  })

  it('operator-only creation with a unique name key', async () => {
    await withRollback(async (tx) => {
      const op = await operator(tx)
      const univ = await institution(tx, 'university', '만들기대학교')
      const [u] = await members(tx, univ.id, 'university', 1)
      await expectServiceError(createTopic(tx, { userId: u! }, { name: '대학원', category: 'grad_school' }, at(1)), 'FORBIDDEN', 'operator_only')
      const name = `대학원 ${crypto.randomUUID().slice(0, 4)}`
      const created = await createTopic(tx, op, { name, category: 'grad_school' }, at(1))
      expect(created).toMatchObject({ kind: 'topic', nameMode: 'affiliated_anonymous', school: null })
      expect(created.boards.map((b) => [b.kind, b.title])).toEqual([['general', '게시판']])
      const dup = await expectServiceError(createTopic(tx, op, { name: ` ${name.toUpperCase()} `, category: 'career' }, at(2)), 'CONFLICT', 'topic_exists')
      expect(dup.details).toMatchObject({ slug: created.slug })
      const badCategory = await expectServiceError(createTopic(tx, op, { name: '다른 토픽', category: 'salary' }, at(2)), 'VALIDATION')
      expect(badCategory.fields).toEqual({ category: 'invalid' })
    })
  })
})
