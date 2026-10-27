/**
 * S-05 프로필 글·활동 목록·팔로우 피드·추천 통합 테스트(DELIVERY_PLAN §4.2 S-05·§5.2 Q·S·T, SYSTEM_DESIGN §6.7.1·§8.3·§11.3, ADR 0035).
 *
 * - 원천마다 투영(원본 모듈 outbox → worker 처리기)과 거두기(원본 상태가 바뀌는 같은 트랜잭션의 DB 트리거)를 확인합니다.
 * - worker 지연을 흉내 내어(트리거를 끈 채 원본만 숨김) withdrawn_at이 비어 있어도 읽기 시점 재확인이 항목을 빼는지 봅니다.
 * - 차단(양방향)·뮤트(피드만)·공개 범위 축소·비공개 계정·인기 정렬 없음·cursor 페이지·추천 규칙.
 * 모든 읽기는 social DB 역할(`withSocialRole`)로 실행됩니다. 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 행만 봅니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { compareFeedItems } from '@peerchive/domain'
import {
  PERSONA_ACTIVITY_PROJECT_TOPIC,
  and,
  communitySpaces,
  eq,
  gte,
  inArray,
  isNull,
  operators,
  outboxEvents,
  personaActivities,
  seniorNotes,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { handlePersonaActivityProject } from '../../worker/src/persona-activities'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { createSeniorNote, publishSeniorNote, withdrawSeniorNote } from '../server/modules/course-hub/senior-notes'
import { createArchiveTransfer } from '../server/modules/community/archive-transfers'
import { joinSpace } from '../server/modules/community/memberships'
import { hideCommunityItemInTx, unhideCommunityItemInTx } from '../server/modules/community/moderation'
import { scheduleNameModeChange } from '../server/modules/community/name-modes'
import { createOfficialPage } from '../server/modules/community/official'
import { createPost, deletePost } from '../server/modules/community/posts'
import { createRoom, getSpaceDetail, updateSpace } from '../server/modules/community/spaces'
import { updateRealName, upsertProfile } from '../server/modules/identity/profiles'
import { createLog } from '../server/modules/logs/logs'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { createBlock, createMute } from '../server/modules/social/blocks'
import { SOCIAL_DB_ROLE_ENV, resolveSocialRole } from '../server/modules/social/db-role'
import { getFeed, getFollowSuggestions, getProfileActivity } from '../server/modules/social/feed'
import { approveFollowRequest, followProfile, getMyFollows } from '../server/modules/social/follows'
import { createDisplayPersona, listMyPersonas, updatePersona } from '../server/modules/social/personas'
import { createProfilePost, deleteProfilePost } from '../server/modules/social/profile-posts'
import { setProjectListing, setVisibility } from '../server/modules/social/visibility'
import { applyNameModeChange } from '../../worker/src/ops/name-modes'
import { NAME_MODE_CHANGE_DELAY_MS } from '@peerchive/domain'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-10T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)
const DB_TIMEOUT = 60_000
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }

interface P {
  userId: string
  actor: { userId: string }
  real: { id: string; handle: string }
  display: { id: string; handle: string } | null
}

async function makeSchool(tx: DbExecutor) {
  const op = await createUser(tx, { displayName: '운영자' })
  await tx.insert(operators).values({ userId: op.id })
  const school = await createSchool(tx, { userId: op.id }, { name: `피드대${rand()}학교`, confirmNew: true }, T0)
  return { opId: op.id, schoolId: school.id }
}

async function makePerson(
  tx: DbExecutor,
  schoolId: string | null,
  opts: { display?: boolean; jobTargets?: string[]; badge?: boolean; name?: string } = {},
): Promise<P> {
  const tag = rand()
  const u = await createUser(tx, { displayName: opts.name ?? `계정${tag}` })
  const actor = { userId: u.id }
  if (schoolId) await verifiedAffiliation(tx, u.id, schoolId)
  await updateRealName(tx, actor, { realName: `실명${tag}` })
  const handle = `r-${tag}`
  await upsertProfile(tx, actor, { handle, displayName: opts.name ?? `계정${tag}`, jobTargets: opts.jobTargets ?? [], showAffiliationBadge: opts.badge ?? false })
  const real = { id: (await listMyPersonas(tx, actor)).personas.find((p) => p.kind === 'real')!.id, handle }
  let display: P['display'] = null
  if (opts.display) {
    const dHandle = `d-${tag}`
    const created = await createDisplayPersona(tx, actor, { handle: dHandle, displayName: `밤의개발자${tag}`, jobTargets: opts.jobTargets ?? [] }, T0)
    display = { id: created.id, handle: dHandle }
  }
  return { userId: u.id, actor, real, display }
}

/** worker 대신: 이 테스트 트랜잭션에서 생긴 투영 요청을 처리합니다(처리 함수는 worker의 것). */
async function drain(tx: DbExecutor): Promise<number> {
  const rows = await tx
    .select({ id: outboxEvents.id, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.topic, PERSONA_ACTIVITY_PROJECT_TOPIC), isNull(outboxEvents.dispatchedAt), gte(outboxEvents.createdAt, new Date(T0.getTime() - days(1)))))
  let n = 0
  for (const r of rows) n += await handlePersonaActivityProject(tx, r.payload)
  if (rows.length) await tx.update(outboxEvents).set({ dispatchedAt: sql`now()` }).where(inArray(outboxEvents.id, rows.map((r) => r.id)))
  return n
}

async function projectEvents(tx: DbExecutor, sourceId: string) {
  return tx
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.topic, PERSONA_ACTIVITY_PROJECT_TOPIC), sql`${outboxEvents.payload}->>'sourceId' = ${sourceId}`))
}

async function activityRows(tx: DbExecutor, sourceId: string) {
  return tx.select().from(personaActivities).where(eq(personaActivities.sourceId, sourceId))
}

const feedIds = async (tx: DbExecutor, p: P) => (await getFeed(tx, p.actor)).items.map((i) => i.id)
const activityTitles = async (tx: DbExecutor, viewer: P | null, handle: string) =>
  (await getProfileActivity(tx, viewer?.actor ?? null, handle)).items.map((i) => i.title ?? i.body)

/** 지난 학기 과목에 연결된 개인 과제를 요약 공개로 게시합니다(공개 사례). */
async function publishCase(tx: DbExecutor, owner: P, schoolId: string, title: string, minute: number) {
  const actor = owner.actor
  const course = await createCourse(tx, actor, schoolId, { title: `운영체제${rand()}`, code: `OS-${rand()}`, confirmNew: true }, T0)
  const { term } = await createCourseTerm(tx, actor, course.id, { year: 2025, semester: 'fall' }, T0)
  const project = await createProject(tx, actor, { title: `비공개 ${rand()}`, courseTermId: term.id }, at(minute))
  const log = (await createLog(tx, actor, project.id, { tag: 'progress', body: '파서 완성', links: [] }, at(minute))).log
  const candidate = await createCandidate(
    tx,
    actor,
    project.id,
    { level: 'summary', title, summary: '파이프를 구현했다.', slug: `case-${rand()}`, logIds: [log.id], milestoneIds: [], exposure: { [owner.userId]: 'name' }, consentSelf: true },
    at(minute),
    ORIGINS,
  )
  const result = await publishCandidate(tx, actor, candidate.id, { manifestHash: candidate.manifestHash }, at(minute + 1))
  return { publicationId: result.publication.id, releaseId: candidate.id, courseId: course.id }
}

const NOTE = (displayMode: 'name' | 'display' | 'anonymous') => ({
  displayMode,
  ...(displayMode === 'display' && { displayName: '조언하는 선배' }),
  termLabel: '2025년 2학기',
  totalTimeBucket: 'lt40h',
  answers: { firstWeek: '과제 명세를 끝까지 읽기', timeSink: '파이프 디버깅', wishKnew: '시그널 처리' },
  noAnswersConfirmed: true,
})

describe('S-05 social DB role setting', () => {
  it('switches to peerchive_social by default; `off` only outside production (fail closed); rejects odd names', () => {
    expect(resolveSocialRole({ NODE_ENV: 'test' })).toBe('peerchive_social')
    expect(resolveSocialRole({ NODE_ENV: 'development', [SOCIAL_DB_ROLE_ENV]: 'off' })).toBe('')
    expect(resolveSocialRole({ NODE_ENV: 'production', [SOCIAL_DB_ROLE_ENV]: 'off' })).toBe('peerchive_social')
    expect(resolveSocialRole({ [SOCIAL_DB_ROLE_ENV]: 'off' })).toBe('peerchive_social') // NODE_ENV 없음 = production 취급
    expect(resolveSocialRole({ NODE_ENV: 'production', [SOCIAL_DB_ROLE_ENV]: 'app_social' })).toBe('app_social')
    expect(resolveSocialRole({ NODE_ENV: 'test', [SOCIAL_DB_ROLE_ENV]: 'x; drop table users' })).toBe('peerchive_social')
  })
})

describe.skipIf(!databaseUrl)('S-05 profile posts (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('own persona only, 1–500 chars, text only, rate limited; projected in the same transaction; delete withdraws in the same transaction', async () => {
    await withRollback(async (tx) => {
      const A = await makePerson(tx, null, { display: true })
      const B = await makePerson(tx, null)
      await expectServiceError(createProfilePost(tx, B.actor, A.real.id, { body: '남의 프로필' }, at(1)), 'NOT_FOUND')
      const empty = await expectServiceError(createProfilePost(tx, A.actor, A.real.id, { body: '   ' }, at(1)), 'VALIDATION')
      expect(empty.fields).toEqual({ body: 'required' })
      expect((await expectServiceError(createProfilePost(tx, A.actor, A.real.id, { body: '가'.repeat(501) }, at(1)), 'VALIDATION')).fields).toEqual({ body: 'too_long' })
      expect(
        (await expectServiceError(createProfilePost(tx, A.actor, A.real.id, { body: '사진', mediaVersionIds: [crypto.randomUUID()] }, at(1)), 'VALIDATION')).fields,
      ).toEqual({ mediaVersionIds: 'not_supported' })

      const post = await createProfilePost(tx, A.actor, A.display!.id, { body: '표시명 프로필의 첫 글' }, at(2))
      const [row] = await activityRows(tx, post.id)
      expect(row).toMatchObject({ personaId: A.display!.id, sourceType: 'profile_post', itemKind: 'posts', withdrawnAt: null })
      // 본인 활동 목록: 지우기용 id가 있음. 로그인한 다른 사람(기본 signed_in): 보이되 지우기 id 없음. 비로그인: 없음.
      const own = await getProfileActivity(tx, A.actor, A.display!.handle)
      expect(own.items).toEqual([expect.objectContaining({ source: 'profile_post', body: '표시명 프로필의 첫 글', profilePostId: post.id })])
      const other = await getProfileActivity(tx, B.actor, A.display!.handle)
      expect(other.items).toHaveLength(1)
      expect(other.items[0]).not.toHaveProperty('profilePostId')
      expect(other.items[0]!.author).toEqual({ kind: 'display', handle: A.display!.handle, displayName: expect.stringMatching(/^밤의개발자/) })
      expect((await getProfileActivity(tx, null, A.display!.handle)).items).toEqual([])
      // 표시명 프로필 글은 실명 프로필 활동에 없음.
      expect((await getProfileActivity(tx, A.actor, A.real.handle)).items).toEqual([])

      await expectServiceError(deleteProfilePost(tx, B.actor, A.display!.id, post.id, at(3)), 'NOT_FOUND')
      await deleteProfilePost(tx, A.actor, A.display!.id, post.id, at(3))
      // 같은 트랜잭션의 트리거가 이미 거둠(worker 없음).
      expect((await activityRows(tx, post.id))[0]!.withdrawnAt).not.toBeNull()
      expect((await getProfileActivity(tx, A.actor, A.display!.handle)).items).toEqual([])
      await deleteProfilePost(tx, A.actor, A.display!.id, post.id, at(4)) // 멱등
      // 숨긴 글(S-07 운영 조치)은 지울 수 없고 활동도 거둠.
      const hidden = await createProfilePost(tx, A.actor, A.real.id, { body: '숨길 글' }, at(5))
      await tx.execute(sql`update profile_posts set status = 'hidden' where id = ${hidden.id}`)
      expect((await activityRows(tx, hidden.id))[0]!.withdrawnAt).not.toBeNull()
      await expectServiceError(deleteProfilePost(tx, A.actor, A.real.id, hidden.id, at(6)), 'CONFLICT', 'hidden')

      // 한도: 시간당 20개(위의 2개 포함).
      for (let i = 0; i < 18; i++) await createProfilePost(tx, A.actor, A.real.id, { body: `글 ${i}` }, at(10 + i))
      await expectServiceError(createProfilePost(tx, A.actor, A.real.id, { body: '한도 초과' }, at(40)), 'RATE_LIMITED')
    })
  }, DB_TIMEOUT)
})

describe.skipIf(!databaseUrl)('S-05 projection wiring: outbox projects, same-transaction trigger withdraws (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('community posts: only real/display posts with a write-time persona in listed spaces emit an event; delete/hide/unlisted withdraw at once; unhide/listed restore', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await makeSchool(tx)
      const A = await makePerson(tx, schoolId, { display: true })
      const rooms: Record<string, { slug: string; board: string }> = {}
      for (const [key, nameMode, discovery] of [['real', 'real', 'listed'], ['display', 'display', 'listed'], ['anon', 'anonymous', 'listed'], ['unlisted', 'real', 'unlisted']] as const) {
        const r = await createRoom(tx, A.actor, { name: `방 ${key} ${rand()}`, nameMode, joinPolicy: 'open', discovery }, T0)
        rooms[key] = { slug: r.slug, board: r.boards[0]!.id }
      }
      const write = (key: string, i: number) => createPost(tx, A.actor, rooms[key]!.board, { title: `글 ${key} ${i}`, body: `본문 ${key}` }, at(i))
      const real1 = await write('real', 1)
      const real2 = await write('real', 2)
      const disp = await write('display', 3)
      const anon = await write('anon', 4)
      const unlisted = await write('unlisted', 5)
      expect(await projectEvents(tx, real1.id)).toHaveLength(1)
      expect(await projectEvents(tx, disp.id)).toHaveLength(1)
      expect(await projectEvents(tx, anon.id)).toEqual([]) // 익명 글은 이벤트 자체가 없음
      expect(await projectEvents(tx, unlisted.id)).toEqual([])
      expect(await drain(tx)).toBe(3)
      expect((await activityRows(tx, real1.id)).map((r) => r.personaId)).toEqual([A.real.id])
      expect((await activityRows(tx, disp.id)).map((r) => r.personaId)).toEqual([A.display!.id])
      // 강제로 익명·unlisted 글 처리를 요청해도 아무것도 생기지 않음.
      const forced = (sourceId: string, personaId: string) => handlePersonaActivityProject(tx, { sourceType: 'community_post', sourceId, personaId, occurredAt: at(1).toISOString() })
      expect(await forced(anon.id, A.real.id)).toBe(0)
      expect(await forced(anon.id, A.display!.id)).toBe(0)
      expect(await forced(unlisted.id, A.real.id)).toBe(0)
      expect(await forced(disp.id, A.real.id)).toBe(0) // 다른 종류 페르소나
      // 중복 전달은 멱등.
      expect(await forced(real1.id, A.real.id)).toBe(0)
      expect((await projectEvents(tx, real1.id)).map((e) => e.payload)).toEqual([
        { sourceType: 'community_post', sourceId: real1.id, personaId: A.real.id, occurredAt: at(1).toISOString() },
      ])

      await deletePost(tx, A.actor, real1.id, at(10))
      expect((await activityRows(tx, real1.id))[0]!.withdrawnAt).not.toBeNull()
      await hideCommunityItemInTx(tx, 'post', real2.id, at(11))
      expect((await activityRows(tx, real2.id))[0]!.withdrawnAt).not.toBeNull()
      await unhideCommunityItemInTx(tx, 'post', real2.id, at(12))
      expect((await activityRows(tx, real2.id))[0]!.withdrawnAt).toBeNull()
      await updateSpace(tx, A.actor, rooms.display!.slug, { discovery: 'unlisted' }, at(13))
      expect((await activityRows(tx, disp.id))[0]!.withdrawnAt).not.toBeNull()
      await updateSpace(tx, A.actor, rooms.display!.slug, { discovery: 'listed' }, at(14))
      expect((await activityRows(tx, disp.id))[0]!.withdrawnAt).toBeNull()
      // 지운 글은 listed로 돌아와도 되살아나지 않음(원천 재확인).
      await updateSpace(tx, A.actor, rooms.real!.slug, { discovery: 'unlisted' }, at(15))
      await updateSpace(tx, A.actor, rooms.real!.slug, { discovery: 'listed' }, at(16))
      expect((await activityRows(tx, real1.id))[0]!.withdrawnAt).not.toBeNull()
      expect((await activityRows(tx, real2.id))[0]!.withdrawnAt).toBeNull()
      // 거둔 행을 SQL로 되살리려 해도 원천이 지워졌으면 트리거가 거부.
      await expect(tx.transaction((i) => i.execute(sql`update persona_activities set withdrawn_at = null where source_id = ${real1.id}`))).rejects.toThrow()
    })
  }, DB_TIMEOUT)

  it('senior notes (name → real, display → display, anonymous → none) and public cases (real persona, consented) project via outbox and withdraw with the source', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await makeSchool(tx)
      const A = await makePerson(tx, schoolId, { display: true })
      const course = await createCourse(tx, A.actor, schoolId, { title: `자료구조${rand()}`, code: `DS-${rand()}`, confirmNew: true }, T0)
      const notes: Record<string, string> = {}
      for (const mode of ['name', 'display', 'anonymous'] as const) {
        const created = await createSeniorNote(tx, A.actor, course.id, NOTE(mode), at(1))
        await publishSeniorNote(tx, A.actor, created.id, { expectedVersion: created.version, confirmWarnings: true }, at(2))
        notes[mode] = created.id
      }
      expect(await projectEvents(tx, notes.anonymous!)).toEqual([])
      const pub = await publishCase(tx, A, schoolId, '셸 구현 사례', 5)
      expect((await projectEvents(tx, pub.releaseId)).map((e) => e.payload)).toEqual([{ sourceType: 'publication_release', sourceId: pub.releaseId }])
      await drain(tx)
      expect((await activityRows(tx, notes.name!)).map((r) => [r.personaId, r.itemKind])).toEqual([[A.real.id, 'notes_and_studies']])
      expect((await activityRows(tx, notes.display!)).map((r) => r.personaId)).toEqual([A.display!.id])
      expect(await activityRows(tx, notes.anonymous!)).toEqual([])
      expect((await activityRows(tx, pub.releaseId)).map((r) => [r.personaId, r.itemKind])).toEqual([[A.real.id, 'cases']])
      // 공개 사례 카드: 제목·링크(/p/slug). 표시명 프로필에는 없음.
      const realActivity = await getProfileActivity(tx, null, A.real.handle)
      expect(realActivity.kinds).toEqual(['cases'])
      expect(realActivity.items).toEqual([expect.objectContaining({ source: 'publication_release', title: '셸 구현 사례', href: expect.stringMatching(/^\/p\/case-/) })])

      await withdrawSeniorNote(tx, A.actor, notes.name!, at(10))
      expect((await activityRows(tx, notes.name!))[0]!.withdrawnAt).not.toBeNull()
      // 운영 숨김(T-15)도 같은 트리거.
      await tx.update(seniorNotes).set({ status: 'hidden' }).where(eq(seniorNotes.id, notes.display!))
      expect((await activityRows(tx, notes.display!))[0]!.withdrawnAt).not.toBeNull()
      await withdrawPublication(tx, A.actor, pub.publicationId, {}, at(11))
      expect((await activityRows(tx, pub.releaseId))[0]!.withdrawnAt).not.toBeNull()
      expect((await getProfileActivity(tx, null, A.real.handle)).items).toEqual([])
    })
  }, DB_TIMEOUT)

  it('read-time re-check: a hidden source disappears from activity and feed even while withdrawn_at is still null (worker lag simulated)', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await makeSchool(tx)
      const A = await makePerson(tx, schoolId)
      const F = await makePerson(tx, schoolId)
      await followProfile(tx, F.actor, A.real.handle, { as: F.real.id }, at(0))
      const course = await createCourse(tx, A.actor, schoolId, { title: `네트워크${rand()}`, code: `NW-${rand()}`, confirmNew: true }, T0)
      const note = await createSeniorNote(tx, A.actor, course.id, NOTE('name'), at(1))
      await publishSeniorNote(tx, A.actor, note.id, { expectedVersion: note.version, confirmWarnings: true }, at(2))
      const post = await createProfilePost(tx, A.actor, A.real.id, { body: '프로필 글' }, at(3))
      await drain(tx)
      expect((await getFeed(tx, F.actor)).items.map((i) => i.source).sort()).toEqual(['profile_post', 'senior_note'])
      // 트리거를 끈 채(= 거두기가 아직 반영되지 않은 상태) 원본만 숨김.
      await tx.execute(sql`set local session_replication_role = replica`)
      await tx.update(seniorNotes).set({ status: 'hidden' }).where(eq(seniorNotes.id, note.id))
      await tx.execute(sql`update profile_posts set status = 'hidden' where id = ${post.id}`)
      await tx.execute(sql`set local session_replication_role = origin`)
      expect((await activityRows(tx, note.id))[0]!.withdrawnAt).toBeNull()
      expect((await activityRows(tx, post.id))[0]!.withdrawnAt).toBeNull()
      expect((await getFeed(tx, F.actor)).items).toEqual([])
      expect((await getProfileActivity(tx, F.actor, A.real.handle)).items).toEqual([])
      expect((await getProfileActivity(tx, A.actor, A.real.handle)).items).toEqual([])
    })
  }, DB_TIMEOUT)
})

describe.skipIf(!databaseUrl)('S-05 scenarios Q and S (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('Q: anonymous posts never reach activity/feed/suggestions; anonymous → real room switch does not promote old posts; an archive copy appears only as a senior note with no link to the original', async () => {
    await withRollback(async (tx) => {
      const { schoolId, opId } = await makeSchool(tx)
      const D = await makePerson(tx, schoolId, { display: true, jobTargets: ['backend'] })
      const F = await makePerson(tx, schoolId, { display: true, jobTargets: ['backend'] })
      await followProfile(tx, F.actor, D.display!.handle, { as: F.display!.id }, at(0))
      await followProfile(tx, F.actor, D.real.handle, { as: F.real.id }, at(0))
      await setVisibility(tx, D.actor, D.display!.id, { items: { posts: 'public', notes_and_studies: 'public' } }, at(0))
      const course = await createCourse(tx, D.actor, schoolId, { title: `운영체제${rand()}`, code: `OS-${rand()}`, confirmNew: true }, T0)
      // 공식 학교 페이지의 익명 글(@devjimin의 주인이 씀).
      const official = await createOfficialPage(tx, { userId: opId }, { schoolId }, T0)
      const detail = await getSpaceDetail(tx, D.actor, official.slug, T0)
      const freeBoard = detail.boards.find((b) => b.kind === 'free')!.id
      const anon = await createPost(tx, D.actor, freeBoard, { title: '익명 고민 QQ1', body: '익명 본문 QQ1 첫 주에 명세를 읽으세요' }, at(1))
      // 익명 사용자 방 → 실명으로 바뀐 뒤에도 이전 글은 그대로 익명.
      const room = await createRoom(tx, D.actor, { name: `익명방 ${rand()}`, nameMode: 'anonymous', joinPolicy: 'open', discovery: 'listed' }, T0)
      await joinSpace(tx, F.actor, room.slug, T0)
      const before = await createPost(tx, D.actor, room.boards[0]!.id, { title: '바뀌기 전 QQ2', body: '익명 본문 QQ2' }, at(2))
      const state = await scheduleNameModeChange(tx, D.actor, room.slug, { toMode: 'real' }, at(3))
      await applyNameModeChange(tx, state.pending!.id, { now: new Date(at(3).getTime() + NAME_MODE_CHANGE_DELAY_MS + 60_000) })
      const later = new Date(at(3).getTime() + NAME_MODE_CHANGE_DELAY_MS + 2 * 60_000)
      const after = await createPost(tx, D.actor, room.boards[0]!.id, { title: '바뀐 뒤 실명 글', body: '실명 본문' }, later)
      // 아카이브로 옮기며 표시명을 고름 → 복사본(선배 노트)만 표시명 페르소나에.
      const transfer = await createArchiveTransfer(
        tx,
        D.actor,
        anon.id,
        { target: 'senior_note', courseId: course.id, answerKey: 'firstWeek', displayMode: 'display', displayName: '조언하는 선배', noAnswersConfirmed: true },
        later,
      )
      const noteId = transfer.result.seniorNoteId!
      const [draft] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, noteId))
      await tx.update(seniorNotes).set({ answers: { ...draft!.answers, wishKnew: '페이지 테이블' } }).where(eq(seniorNotes.id, noteId))
      await publishSeniorNote(tx, D.actor, noteId, { expectedVersion: draft!.version, confirmWarnings: true }, new Date(later.getTime() + 60_000))
      expect(await projectEvents(tx, anon.id)).toEqual([])
      expect(await projectEvents(tx, before.id)).toEqual([])
      await drain(tx)
      for (const id of [anon.id, before.id]) {
        expect(await activityRows(tx, id)).toEqual([])
        for (const personaId of [D.real.id, D.display!.id])
          expect(await handlePersonaActivityProject(tx, { sourceType: 'community_post', sourceId: id, personaId, occurredAt: at(1).toISOString() })).toBe(0)
      }
      expect((await activityRows(tx, after.id)).map((r) => r.personaId)).toEqual([D.real.id])
      expect((await activityRows(tx, noteId)).map((r) => r.personaId)).toEqual([D.display!.id])

      const outputs = JSON.stringify([
        await getFeed(tx, F.actor),
        await getProfileActivity(tx, F.actor, D.display!.handle),
        await getProfileActivity(tx, F.actor, D.real.handle),
        await getProfileActivity(tx, null, D.display!.handle),
        await getFollowSuggestions(tx, F.actor),
      ])
      for (const value of [anon.id, '익명 고민 QQ1', '익명 본문 QQ1', before.id, '바뀌기 전 QQ2', '익명 본문 QQ2', official.slug, at(1).toISOString(), at(2).toISOString()])
        expect(outputs.includes(value), value).toBe(false)
      // 복사본은 선배 노트 카드(과목·학기, /c/ 링크)로만: 원 글 id·공간 이름이 없음.
      const copy = (await getProfileActivity(tx, F.actor, D.display!.handle)).items
      expect(copy).toEqual([expect.objectContaining({ source: 'senior_note', href: `/c/${course.id}`, body: null })])
      expect(JSON.stringify(copy)).not.toContain(official.slug)
      // 실명 프로필에는 실명 글만(표시명 복사본 없음), 표시명 프로필에는 실명 글 없음.
      expect((await getProfileActivity(tx, F.actor, D.real.handle)).items.map((i) => i.title)).toEqual(['바뀐 뒤 실명 글'])
      expect((await getProfileActivity(tx, F.actor, D.display!.handle)).items.map((i) => i.source)).toEqual(['senior_note'])
      expect(await communityDiscovery(tx, room.slug)).toBe('listed')
    })
  }, DB_TIMEOUT)

  it('S: withdrawing a public case removes it from the profile list and the follower feed on the next request', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await makeSchool(tx)
      const A = await makePerson(tx, schoolId)
      const F = await makePerson(tx, null)
      await followProfile(tx, F.actor, A.real.handle, { as: F.real.id }, at(0))
      const pub = await publishCase(tx, A, schoolId, '철회할 사례', 1)
      await drain(tx)
      expect((await getFeed(tx, F.actor)).items.map((i) => i.title)).toEqual(['철회할 사례'])
      expect(await activityTitles(tx, null, A.real.handle)).toEqual(['철회할 사례'])
      await withdrawPublication(tx, A.actor, pub.publicationId, {}, at(5))
      expect((await getFeed(tx, F.actor)).items).toEqual([])
      expect(await activityTitles(tx, null, A.real.handle)).toEqual([])
      expect(await activityTitles(tx, F, A.real.handle)).toEqual([])
    })
  }, DB_TIMEOUT)
})

async function communityDiscovery(tx: DbExecutor, slug: string) {
  const [row] = await tx.select({ discovery: communitySpaces.discovery }).from(communitySpaces).where(eq(communitySpaces.slug, slug))
  return row?.discovery
}

describe.skipIf(!databaseUrl)('S-05 feed rules (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('block hides items both ways, mute hides only from the feed, narrowing the posts audience removes items on the next request', async () => {
    await withRollback(async (tx) => {
      const A = await makePerson(tx, null)
      const B = await makePerson(tx, null)
      const C = await makePerson(tx, null)
      await followProfile(tx, A.actor, B.real.handle, { as: A.real.id }, at(0))
      await followProfile(tx, B.actor, A.real.handle, { as: B.real.id }, at(0))
      await followProfile(tx, A.actor, C.real.handle, { as: A.real.id }, at(0))
      const pa = await createProfilePost(tx, A.actor, A.real.id, { body: 'A의 글' }, at(1))
      const pb = await createProfilePost(tx, B.actor, B.real.id, { body: 'B의 글' }, at(2))
      const pc = await createProfilePost(tx, C.actor, C.real.id, { body: 'C의 글' }, at(3))
      const body = async (p: P) => (await getFeed(tx, p.actor)).items.map((i) => i.body)
      expect(await body(A)).toEqual(['C의 글', 'B의 글'])
      expect(await body(B)).toEqual(['A의 글'])

      // 뮤트: A의 피드에서 C만 빠지고, C의 활동 목록은 A에게 그대로.
      await createMute(tx, A.actor, { handle: C.real.handle }, at(4))
      expect(await body(A)).toEqual(['B의 글'])
      expect(await activityTitles(tx, A, C.real.handle)).toEqual(['C의 글'])
      expect((await getFeed(tx, A.actor)).following).toBe(2)

      // 공개 범위 축소: B가 글을 private로 → A의 피드에서 다음 요청부터 빠짐.
      await setVisibility(tx, B.actor, B.real.id, { items: { posts: 'private' } }, at(5))
      expect(await body(A)).toEqual([])
      await setVisibility(tx, B.actor, B.real.id, { items: { posts: 'signed_in' } }, at(6))
      expect(await body(A)).toEqual(['B의 글'])

      // 차단: B가 A를 차단 → 양방향 팔로우가 끊기고 서로의 피드에서 빠짐. A에게 B의 활동 목록은 404.
      await createBlock(tx, B.actor, { handle: A.real.handle, as: B.real.id }, at(7))
      expect(await body(A)).toEqual([])
      expect(await body(B)).toEqual([])
      await expectServiceError(getProfileActivity(tx, A.actor, B.real.handle), 'NOT_FOUND')
      expect([pa.id, pb.id, pc.id]).toHaveLength(3)
    })
  }, DB_TIMEOUT)

  it('private persona: items only for approved followers; ordering ignores follower counts; cursor pages are complete and disjoint', async () => {
    await withRollback(async (tx) => {
      const V = await makePerson(tx, null)
      const X = await makePerson(tx, null)
      const Y = await makePerson(tx, null)
      await updatePersona(tx, Y.actor, Y.real.id, { accountPrivacy: 'private' }, at(0))
      await followProfile(tx, V.actor, X.real.handle, { as: V.real.id }, at(0))
      expect(await followProfile(tx, V.actor, Y.real.handle, { as: V.real.id }, at(0))).toEqual({ status: 'pending' })
      const y1 = await createProfilePost(tx, Y.actor, Y.real.id, { body: 'Y 비공개 계정의 글' }, at(1))
      expect(await activityTitles(tx, V, Y.real.handle)).toEqual([]) // 승인 전
      expect(await feedIds(tx, V)).toEqual([])
      const req = (await getMyFollows(tx, Y.actor, Y.real.id)).incoming[0]!
      await approveFollowRequest(tx, Y.actor, req.id, at(2))
      expect(await activityTitles(tx, V, Y.real.handle)).toEqual(['Y 비공개 계정의 글'])
      expect((await getFeed(tx, V.actor)).items.map((i) => i.profilePostId ?? i.body)).toEqual(['Y 비공개 계정의 글'])
      expect(await activityTitles(tx, X, Y.real.handle)).toEqual([]) // 팔로워가 아닌 로그인 사용자
      expect(y1.id).toBeTruthy()

      // 인기 정렬 없음: X에게 팔로워를 잔뜩 붙여도 순서는 시간·종류 규칙 그대로.
      const x1 = await createProfilePost(tx, X.actor, X.real.id, { body: 'X 오래된 글' }, at(3))
      const y2 = await createProfilePost(tx, Y.actor, Y.real.id, { body: 'Y 최근 글' }, at(4))
      const before = await feedIds(tx, V)
      for (let i = 0; i < 6; i++) {
        const fan = await makePerson(tx, null)
        await followProfile(tx, fan.actor, X.real.handle, { as: fan.real.id }, at(5))
      }
      expect(await feedIds(tx, V)).toEqual(before)
      const items = (await getFeed(tx, V.actor)).items
      expect(items.map((i) => i.body)).toEqual(['Y 최근 글', 'X 오래된 글', 'Y 비공개 계정의 글'])
      expect([...items].sort((a, b) => compareFeedItems({ ...a, itemKind: a.kind, createdAt: new Date(a.createdAt) }, { ...b, itemKind: b.kind, createdAt: new Date(b.createdAt) }))).toEqual(items)
      expect([x1.id, y2.id]).toHaveLength(2)

      // 25개 → 20 + 5, 겹치지 않고 빠짐없음(한도를 피해 시간당 하나씩).
      for (let i = 0; i < 22; i++) await createProfilePost(tx, X.actor, X.real.id, { body: `페이지 ${i}` }, new Date(T0.getTime() + days(1) + i * 61 * 60_000))
      const first = await getFeed(tx, V.actor)
      expect(first.items).toHaveLength(20)
      expect(first.nextCursor).not.toBeNull()
      const second = await getFeed(tx, V.actor, { cursor: first.nextCursor })
      expect(second.items).toHaveLength(5)
      expect(second.nextCursor).toBeNull()
      const all = [...first.items, ...second.items].map((i) => i.id)
      expect(new Set(all).size).toBe(25)
      await expectServiceError(getFeed(tx, V.actor, { cursor: 'nope' }), 'VALIDATION')
      // 활동 목록 cursor도 같은 방식.
      const p1 = await getProfileActivity(tx, V.actor, X.real.handle)
      const p2 = await getProfileActivity(tx, V.actor, X.real.handle, { cursor: p1.nextCursor })
      expect(p1.items).toHaveLength(20)
      expect(p2.items).toHaveLength(3)
      expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(23)
      await expectServiceError(getProfileActivity(tx, V.actor, X.real.handle, { kind: 'case_studies' }), 'VALIDATION')
      expect((await getProfileActivity(tx, V.actor, X.real.handle, { kind: 'cases' })).items).toEqual([])
    })
  }, DB_TIMEOUT)

  it('records come before posts within a KST day (cases/notes/studies first), newest day first', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await makeSchool(tx)
      const A = await makePerson(tx, schoolId)
      const F = await makePerson(tx, null)
      await followProfile(tx, F.actor, A.real.handle, { as: F.real.id }, at(0))
      await createProfilePost(tx, A.actor, A.real.id, { body: '같은 날 늦은 글' }, at(120)) // KST 20:00
      await publishCase(tx, A, schoolId, '같은 날 이른 사례', 10) // KST 18:11
      await createProfilePost(tx, A.actor, A.real.id, { body: '다음 날 글' }, at(60 * 7)) // KST 다음 날 01:00
      await drain(tx)
      expect((await getFeed(tx, F.actor)).items.map((i) => i.title ?? i.body)).toEqual(['다음 날 글', '같은 날 이른 사례', '같은 날 늦은 글'])
    })
  }, DB_TIMEOUT)
})

describe.skipIf(!databaseUrl)('S-05 follow suggestions (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('course ∩ visible listings, same school (real persona with a public badge only), job targets; excludes self, followed, blocked both ways, muted; one persona per person', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await makeSchool(tx)
      const V = await makePerson(tx, schoolId, { jobTargets: ['backend'] })
      const course = await createCourse(tx, V.actor, schoolId, { title: `컴파일러${rand()}`, code: `CC-${rand()}`, confirmNew: true }, T0)
      const { term } = await createCourseTerm(tx, V.actor, course.id, { year: 2025, semester: 'fall' }, T0)
      await createProject(tx, V.actor, { title: `내 과제 ${rand()}`, courseTermId: term.id }, at(1))

      const job = await makePerson(tx, null, { jobTargets: ['Backend '] })
      const badge = await makePerson(tx, schoolId, { badge: true })
      const noBadge = await makePerson(tx, schoolId, { badge: false })
      const displayOnly = await makePerson(tx, schoolId, { display: true, badge: true }) // 실명 페르소나가 학교로 추천됨, 표시명은 아님
      const both = await makePerson(tx, null, { display: true, jobTargets: ['backend'] }) // 두 페르소나 모두 직무 일치 → 하나만
      const lister = await makePerson(tx, null)
      const privateLister = await makePerson(tx, null)
      for (const who of [lister, privateLister]) {
        const p = await createProject(tx, who.actor, { title: `같은 과목 과제 ${rand()}`, courseTermId: term.id }, at(2))
        await setProjectListing(tx, who.actor, who.real.id, { projectId: p.id, shown: true }, at(3))
      }
      await setVisibility(tx, lister.actor, lister.real.id, { items: { project_list: 'signed_in' } }, at(3))
      const followed = await makePerson(tx, null, { jobTargets: ['backend'] })
      const blockedByV = await makePerson(tx, null, { jobTargets: ['backend'] })
      const blocksV = await makePerson(tx, null, { jobTargets: ['backend'] })
      const muted = await makePerson(tx, null, { jobTargets: ['backend'] })
      await followProfile(tx, V.actor, followed.real.handle, { as: V.real.id }, at(4))
      await createBlock(tx, V.actor, { handle: blockedByV.real.handle, as: V.real.id }, at(4))
      await createBlock(tx, blocksV.actor, { handle: V.real.handle, as: blocksV.real.id }, at(4))
      await createMute(tx, V.actor, { handle: muted.real.handle }, at(4))

      const { suggestions } = await getFollowSuggestions(tx, V.actor)
      const byHandle = new Map(suggestions.map((s) => [s.handle, s]))
      expect(byHandle.get(job.real.handle)?.reasons).toEqual(['job_target'])
      expect(byHandle.get(badge.real.handle)?.reasons).toEqual(['institution'])
      expect(byHandle.get(displayOnly.real.handle)?.reasons).toEqual(['institution'])
      expect(byHandle.has(displayOnly.display!.handle)).toBe(false)
      expect(byHandle.has(noBadge.real.handle)).toBe(false)
      expect(byHandle.get(lister.real.handle)?.reasons).toEqual(['course'])
      expect(byHandle.has(privateLister.real.handle)).toBe(false) // 과제 수행 목록이 비공개(기본)면 과목 신호 없음
      expect([byHandle.has(both.real.handle), byHandle.has(both.display!.handle)].filter(Boolean)).toHaveLength(1)
      for (const excluded of [V.real.handle, followed.real.handle, blockedByV.real.handle, blocksV.real.handle, muted.real.handle])
        expect(byHandle.has(excluded), excluded).toBe(false)
      // 키는 공개 기본 정보와 이유뿐.
      for (const s of suggestions) expect(Object.keys(s).sort()).toEqual(['accountPrivacy', 'displayName', 'handle', 'kind', 'reasons'])
      // 같은 사람이 다시 물어도 같은 순서(결정적), 팔로워 수와 무관.
      expect((await getFollowSuggestions(tx, V.actor)).suggestions).toEqual(suggestions)
      expect(suggestions[0]!.handle).toBe(lister.real.handle) // 과목 신호(3점)가 가장 큼
    })
  }, DB_TIMEOUT)
})
