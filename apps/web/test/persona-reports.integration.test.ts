/**
 * S-07 신고·계측 통합 테스트(DELIVERY_PLAN §4.2 S-07·§6.2·§7 GP, SYSTEM_DESIGN §8.3, ADR 0028·0036).
 *
 * - 신고 대상: 페르소나(실명·표시명)·프로필 글(활동 id)·소셜 링크(handle + 주소). 신고자 응답·내 신고에 주인 사용자·다른 페르소나 0건.
 * - 운영자: 대기열·상세는 신고된 페르소나 자신만(표시명 신고에 실명 handle 0건), 주인 확인은 사유 기록 + 감사(id만)로만.
 * - 조치: 페르소나 하나만 숨김(다른 페르소나는 그대로), 프로필 글 숨김 → 활동·피드에서 다음 요청부터 빠짐, 소셜 링크 숨김 → 공개 DTO에서 빠짐·지우기 409.
 *   이의제기 되돌림·운영 해제로 복원. 조치 행에는 메모가 있고 감사에는 id·종류·플래그만.
 * - 분석(§6.2): 사용자 키 + 시 단위 시각, 페르소나 id·handle·상대방 키 0건, 수집 거부 존중, 지표 5 미만 가림.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { analyticsEvents, and, auditEvents, eq, gte, hashSubject, inArray, lt, moderationActions, operators, personaOwnerLookups, sql, type DbExecutor } from '@peerchive/db'
import { analyticsPepper, setAnalyticsEnvForTesting, setAnalyticsOptOut } from '../server/modules/analytics/analytics'
import { upsertProfile } from '../server/modules/identity/profiles'
import { decideAppeal, getReportDetail, listAudit, listReportGroups, resolveReport } from '../server/modules/moderation/operator'
import { createAppeal, listMyModerationNotices } from '../server/modules/moderation/notices'
import { lookupPersonaOwner } from '../server/modules/moderation/personas'
import { createReport, listMyReports } from '../server/modules/moderation/reports'
import { getOperatorMetrics } from '../server/modules/ops/metrics'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createBlock, createMute } from '../server/modules/social/blocks'
import { getFeed, getProfileActivity, recordFeedItemOpened } from '../server/modules/social/feed'
import { approveFollowRequest, followProfile, getMyFollows, removeFollower } from '../server/modules/social/follows'
import { createDisplayPersona, listMyPersonas, setIdentityLink, updatePersona } from '../server/modules/social/personas'
import { createProfilePost, deleteProfilePost } from '../server/modules/social/profile-posts'
import { addSocialLink, listMySocialLinks, publicSocialLinks, removeSocialLink } from '../server/modules/social/social-links'
import { setVisibility } from '../server/modules/social/visibility'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-12T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)
const DB_TIMEOUT = 60_000
const NOTE = '내부 메모: 신고 내용 확인함 SENTINEL_NOTE'
const PEPPER = { NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'persona-s07-analytics-pepper-0123456789abcdef' }

interface P {
  userId: string
  actor: { userId: string }
  name: string
  real: { id: string; handle: string }
  display: { id: string; handle: string; name: string } | null
}

async function makePerson(tx: DbExecutor, opts: { display?: boolean } = {}): Promise<P> {
  const tag = rand()
  const name = `계정${tag}`
  const u = await createUser(tx, { displayName: name })
  const actor = { userId: u.id }
  const handle = `r-${tag}`
  await upsertProfile(tx, actor, { handle, displayName: name })
  const real = { id: (await listMyPersonas(tx, actor)).personas.find((p) => p.kind === 'real')!.id, handle }
  let display: P['display'] = null
  if (opts.display) {
    const dHandle = `d-${tag}`
    const dName = `밤의개발자${tag}`
    const created = await createDisplayPersona(tx, actor, { handle: dHandle, displayName: dName }, T0)
    display = { id: created.id, handle: dHandle, name: dName }
  }
  return { userId: u.id, actor, name, real, display }
}

async function makeOperator(tx: DbExecutor) {
  const op = await createUser(tx, { displayName: '운영자' })
  await tx.insert(operators).values({ userId: op.id })
  return { userId: op.id }
}

/** 응답(JSON)에 이 값들이 하나도 없는지. */
function expectNone(value: unknown, needles: string[]) {
  const json = JSON.stringify(value)
  for (const n of needles) expect(json, n).not.toContain(n)
}

describe.skipIf(!databaseUrl)('S-07 persona reports, moderation and metrics (PostgreSQL)', () => {
  afterEach(() => setAnalyticsEnvForTesting(null))
  afterAll(async () => {
    setAnalyticsEnvForTesting(null)
    await closeTestDb()
  })

  it(
    'reports a display persona without linking it to the real persona; hiding it hides only that persona; appeal restores',
    async () => {
      await withRollback(async (tx) => {
        const A = await makePerson(tx, { display: true })
        const R = await makePerson(tx)
        const O = await makeOperator(tx)
        const D = A.display!
        // 신고 대상·사유 검증
        await expectServiceError(createReport(tx, R.actor, { targetType: 'persona', targetRef: { handle: 'no-such-handle-zz' }, reason: 'spam' }, at(1)), 'NOT_FOUND')
        const receipt = await createReport(tx, R.actor, { targetType: 'persona', targetRef: { handle: D.handle }, reason: 'impersonation', details: '교수님 이름을 씀' }, at(1))
        expect(receipt.created).toBe(true)
        // 신고자 응답·내 신고: 그 페르소나의 handle뿐, 주인·실명 페르소나 0건.
        const mine = await listMyReports(tx, R.actor)
        expect(mine.find((r) => r.id === receipt.id)).toMatchObject({ targetType: 'persona', targetLabel: `공개 프로필 @${D.handle} (표시명)`, reason: 'impersonation', status: 'received' })
        expectNone([receipt, mine], [A.userId, A.real.handle, A.real.id, A.name, D.id])

        // 운영자 대기열·상세: 표시명 페르소나 자신만(실명 handle·계정 id·이름 0건).
        const queue = await listReportGroups(tx, O, { status: 'open' }, at(2))
        const group = queue.find((g) => g.reportId === receipt.id)!
        expect(group.targetLabel).toBe(`공개 프로필 @${D.handle} (표시명)`)
        const detail = await getReportDetail(tx, O, receipt.id, at(2))
        expect(detail.content).toMatchObject({ kind: 'persona', persona: { kind: 'display', handle: D.handle, displayName: D.name, hidden: false } })
        expect(detail.allowedActions).toEqual(['none', 'hide_persona'])
        expect(detail.publicPath).toBe(`/u/${D.handle}`)
        expectNone([group, detail], [A.userId, A.real.handle, A.real.id, A.name])

        // 숨김: 표시명 페르소나만 404, 실명 페르소나는 그대로(함께 사라지면 같은 사람임이 드러남).
        const resolved = await resolveReport(tx, O, receipt.id, { action: 'hide_persona', note: NOTE, publicReason: '다른 사람으로 오인하게 하는 이름', notifyOwner: true }, at(3))
        expect(resolved.report.status).toBe('resolved')
        await expectServiceError(getPublicPortfolioProfile(tx, D.handle, at(4)), 'NOT_FOUND')
        expect((await getPublicPortfolioProfile(tx, A.real.handle, at(4))).handle).toBe(A.real.handle)
        await expectServiceError(createReport(tx, R.actor, { targetType: 'persona', targetRef: { handle: D.handle }, reason: 'spam' }, at(4)), 'NOT_FOUND')
        // 같은 사람의 실명 프로필은 여전히 신고할 수 있고 별도 대상입니다.
        const realReport = await createReport(tx, R.actor, { targetType: 'persona', targetRef: { handle: A.real.handle }, reason: 'spam' }, at(4))
        expect((await getReportDetail(tx, O, realReport.id, at(4))).content).toMatchObject({ kind: 'persona', persona: { kind: 'real', handle: A.real.handle, hidden: false } })

        // 조치 행: 메모 있음. 감사: id·종류·플래그만(메모·사유·handle 없음).
        const [action] = await tx.select().from(moderationActions).where(eq(moderationActions.id, resolved.actions[0]!.id))
        expect(action).toMatchObject({ kind: 'hide_persona', personaId: D.id, internalNote: NOTE, profileUserId: null })
        const audits = await tx.select().from(auditEvents).where(sql`${auditEvents.metadata}->>'actionId' = ${action!.id} or ${auditEvents.targetId} = ${receipt.id}`)
        expect(audits.map((a) => a.action).sort()).toEqual(['moderation.apply', 'report.create', 'report.resolve'])
        expect(audits.find((a) => a.action === 'moderation.apply')).toMatchObject({ targetType: 'persona', targetId: D.id })
        expectNone(audits.map((a) => a.metadata), [NOTE, 'SENTINEL', '오인', '교수님', D.handle, A.real.handle, A.userId])

        // 당사자 안내·이의제기 → 되돌림 → 다시 공개.
        const notices = await listMyModerationNotices(tx, A.actor)
        expect(notices.find((n) => n.actionId === action!.id)).toMatchObject({ kind: 'hide_persona', ownerPath: '/settings/personas', canAppeal: true })
        await expectServiceError(createAppeal(tx, R.actor, { actionId: action!.id, message: '남의 이의' }, at(5)), 'NOT_FOUND')
        // 본인이 이름을 고친 뒤 이의제기(사칭 처리 기준: 숨김 + 사유, 고치면 다시 열 수 있음).
        await updatePersona(tx, A.actor, D.id, { displayName: '밤의개발자 개인' }, at(5))
        const appeal = await createAppeal(tx, A.actor, { actionId: action!.id, message: '이름을 바꿨습니다' }, at(5))
        await decideAppeal(tx, O, appeal.id, { decision: 'reverse', note: '고친 이름 확인' }, at(6))
        expect((await getPublicPortfolioProfile(tx, D.handle, at(7))).displayName).toBe('밤의개발자 개인')
      })
    },
    DB_TIMEOUT,
  )

  it(
    'operator owner lookup needs a reason, is audited with ids only and is the only way to reach the other persona',
    async () => {
      await withRollback(async (tx) => {
        const A = await makePerson(tx, { display: true })
        const R = await makePerson(tx)
        const O = await makeOperator(tx)
        const report = await createReport(tx, R.actor, { targetType: 'persona', targetRef: { handle: A.display!.handle }, reason: 'harassment' }, at(1))
        await expectServiceError(lookupPersonaOwner(tx, R.actor, { reportId: report.id, reason: '궁금' }, at(2)), 'FORBIDDEN', 'operator_only')
        await expectServiceError(lookupPersonaOwner(tx, O, { reportId: report.id, reason: '' }, at(2)), 'VALIDATION')
        const result = await lookupPersonaOwner(tx, O, { reportId: report.id, reason: '반복 괴롭힘 — 계정 정지 검토 SENTINEL_REASON' }, at(2))
        expect(result.owner.userId).toBe(A.userId)
        expect(result.owner.personas.map((p) => p.handle).sort()).toEqual([A.display!.handle, A.real.handle].sort())
        expect(result.owner).toMatchObject({ accountStatus: 'active', linkVisible: false, activeActions: 0 })
        const [row] = await tx.select().from(personaOwnerLookups).where(eq(personaOwnerLookups.id, result.lookupId))
        expect(row).toMatchObject({ operatorId: O.userId, reportId: report.id, personaId: A.display!.id, ownerUserId: A.userId })
        const audit = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'persona.owner_lookup'))
        const mineAudit = audit.filter((a) => a.metadata.lookupId === result.lookupId)
        expect(mineAudit).toHaveLength(1)
        expect(mineAudit[0]!.metadata).toEqual({ lookupId: result.lookupId, reportId: report.id })
        expectNone(mineAudit, ['SENTINEL_REASON', A.userId, A.real.handle])
        // 신고 상세는 확인 뒤에도 그대로(확인 결과를 저장된 화면에 싣지 않음).
        expectNone(await getReportDetail(tx, O, report.id, at(3)), [A.userId, A.real.handle])

        // 감사 조회 우회 막기: 조치 id → 페르소나 id → 주인이 남긴 persona.create 행의 행위자는 비워져 있습니다.
        const resolved = await resolveReport(tx, O, report.id, { action: 'hide_persona', note: NOTE }, at(4))
        const viaAction = await listAudit(tx, O, { target: resolved.actions[0]!.id })
        const personaTarget = viaAction.find((a) => a.action === 'moderation.apply')!.targetId!
        const viaPersona = await listAudit(tx, O, { target: personaTarget })
        expect(viaPersona.find((a) => a.action === 'persona.create')).toMatchObject({ actorId: null })
        expectNone(viaPersona, [A.userId])
        // 다른 종류의 신고(이전 사용자 단위 프로필 신고 등)로는 확인할 수 없습니다.
        const other = await makePerson(tx)
        const legacy = await createReport(tx, R.actor, { targetType: 'profile', targetRef: { handle: other.real.handle }, reason: 'spam' }, at(5))
        await expectServiceError(lookupPersonaOwner(tx, O, { reportId: legacy.id, reason: '확인' }, at(6)), 'VALIDATION')
      })
    },
    DB_TIMEOUT,
  )

  it(
    'hides a profile post (activity and feed drop it on the next request) and a social link (public DTO drops it, owner cannot delete); reversal restores',
    async () => {
      await withRollback(async (tx) => {
        const A = await makePerson(tx, { display: true })
        const R = await makePerson(tx)
        const O = await makeOperator(tx)
        await followProfile(tx, R.actor, A.display!.handle, { as: R.real.id }, at(0))
        await createProfilePost(tx, A.actor, A.display!.id, { body: '문제의 글 SENTINEL_POST' }, at(1))
        const activity = await getProfileActivity(tx, R.actor, A.display!.handle)
        const item = activity.items.find((i) => i.body?.includes('SENTINEL_POST'))!
        expect(item.profilePostId).toBeUndefined()
        expect((await getFeed(tx, R.actor)).items.map((i) => i.id)).toContain(item.id)

        // 프로필 글 신고: 활동 id로만. 사칭 사유는 프로필 신고에만(422).
        await expectServiceError(
          createReport(tx, R.actor, { targetType: 'profile_post', targetRef: { activityId: item.id }, reason: 'impersonation' }, at(2)),
          'VALIDATION',
        )
        await expectServiceError(createReport(tx, R.actor, { targetType: 'profile_post', targetRef: { activityId: crypto.randomUUID() }, reason: 'spam' }, at(2)), 'NOT_FOUND')
        const postReport = await createReport(tx, R.actor, { targetType: 'profile_post', targetRef: { activityId: item.id }, reason: 'harassment' }, at(2))
        expectNone([postReport, await listMyReports(tx, R.actor)], [A.userId, A.real.handle, A.real.id])
        const postDetail = await getReportDetail(tx, O, postReport.id, at(3))
        expect(postDetail.content).toMatchObject({ kind: 'profile_post', persona: { handle: A.display!.handle, kind: 'display' }, post: { status: 'published' } })
        expectNone(postDetail, [A.real.handle, A.userId])
        const postResolved = await resolveReport(tx, O, postReport.id, { action: 'hide_profile_post', note: NOTE, publicReason: '괴롭힘', notifyOwner: true }, at(3))
        expect((await getProfileActivity(tx, R.actor, A.display!.handle)).items.map((i) => i.id)).not.toContain(item.id)
        expect((await getProfileActivity(tx, A.actor, A.display!.handle)).items.map((i) => i.id)).not.toContain(item.id)
        expect((await getFeed(tx, R.actor)).items.map((i) => i.id)).not.toContain(item.id)
        // 숨긴 글은 지울 수 없고(근거 보존), 페르소나 자체는 그대로 공개입니다.
        const [postAction] = await tx.select().from(moderationActions).where(eq(moderationActions.id, postResolved.actions[0]!.id))
        await expectServiceError(deleteProfilePost(tx, A.actor, A.display!.id, postAction!.profilePostId!, at(4)), 'CONFLICT', 'hidden')
        expect((await getPublicPortfolioProfile(tx, A.display!.handle, at(4))).handle).toBe(A.display!.handle)
        const postAppeal = await createAppeal(tx, A.actor, { reportId: postReport.id, message: '오해입니다' }, at(4))
        await decideAppeal(tx, O, postAppeal.id, { decision: 'reverse', note: '되돌림' }, at(5))
        expect((await getProfileActivity(tx, R.actor, A.display!.handle)).items.map((i) => i.id)).toContain(item.id)
        expect((await getFeed(tx, R.actor)).items.map((i) => i.id)).toContain(item.id)

        // 소셜 링크: handle + 공개 주소로 신고.
        const link = await addSocialLink(tx, A.actor, A.display!.id, { provider: 'blog', url: `https://blog.example.com/${rand()}` }, at(6))
        const other = await addSocialLink(tx, A.actor, A.real.id, { provider: 'github', url: `https://github.com/k${rand()}` }, at(6))
        await expectServiceError(
          createReport(tx, R.actor, { targetType: 'social_link', targetRef: { handle: A.display!.handle, url: other.url }, reason: 'spam' }, at(7)),
          'NOT_FOUND',
        )
        const linkReport = await createReport(tx, R.actor, { targetType: 'social_link', targetRef: { handle: A.display!.handle, url: link.url }, reason: 'spam' }, at(7))
        const linkDetail = await getReportDetail(tx, O, linkReport.id, at(7))
        expect(linkDetail.content).toMatchObject({ kind: 'social_link', link: { url: link.url, hidden: false } })
        expectNone(linkDetail, [A.real.handle, other.url, A.userId])
        const linkResolved = await resolveReport(tx, O, linkReport.id, { action: 'hide_social_link', note: NOTE }, at(8))
        expect((await publicSocialLinks(tx, A.display!.id)).map((l) => l.url)).toEqual([])
        expect((await publicSocialLinks(tx, A.real.id)).map((l) => l.url)).toEqual([other.url])
        expect((await getPublicPortfolioProfile(tx, A.display!.handle, at(8))).socialLinks).toEqual([])
        const mineLinks = await listMySocialLinks(tx, A.actor, A.display!.id, 'http://localhost:3000')
        expect(mineLinks.links.find((l) => l.id === link.id)).toMatchObject({ hidden: true })
        await expectServiceError(removeSocialLink(tx, A.actor, link.id), 'CONFLICT', 'hidden')
        const linkAppeal = await createAppeal(tx, A.actor, { actionId: linkResolved.actions[0]!.id, message: '제 블로그입니다' }, at(9))
        await decideAppeal(tx, O, linkAppeal.id, { decision: 'reverse', note: '확인' }, at(9))
        expect((await publicSocialLinks(tx, A.display!.id)).map((l) => l.url)).toEqual([link.url])

        // 감사 metadata: 메모·본문·주소·handle 없음.
        const ids = [postResolved.actions[0]!.id, linkResolved.actions[0]!.id]
        const audits = await tx.select().from(auditEvents).where(inArray(sql`${auditEvents.metadata}->>'actionId'`, ids))
        expect(audits.length).toBeGreaterThanOrEqual(4)
        expectNone(audits.map((a) => a.metadata), [NOTE, 'SENTINEL', link.url, A.display!.handle, A.real.handle])
      })
    },
    DB_TIMEOUT,
  )

  it(
    'blocked reporters cannot report the hidden persona; reporting is per persona (real/display stay separate groups)',
    async () => {
      await withRollback(async (tx) => {
        const A = await makePerson(tx, { display: true })
        const B = await makePerson(tx)
        const O = await makeOperator(tx)
        await createBlock(tx, A.actor, { handle: B.real.handle, as: A.display!.id, scope: 'origin_persona' }, at(1))
        await expectServiceError(createReport(tx, B.actor, { targetType: 'persona', targetRef: { handle: A.display!.handle }, reason: 'spam' }, at(2)), 'NOT_FOUND')
        // 차단 범위 밖의 실명 프로필은 신고할 수 있고, 둘은 서로 다른 묶음입니다.
        const r1 = await createReport(tx, B.actor, { targetType: 'persona', targetRef: { handle: A.real.handle }, reason: 'spam' }, at(2))
        const C = await makePerson(tx)
        const r2 = await createReport(tx, C.actor, { targetType: 'persona', targetRef: { handle: A.display!.handle }, reason: 'spam' }, at(2))
        const groups = await listReportGroups(tx, O, { status: 'open' }, at(3))
        const g1 = groups.find((g) => g.reportId === r1.id)!
        const g2 = groups.find((g) => g.reportId === r2.id)!
        expect(g1.targetLabel).toBe(`공개 프로필 @${A.real.handle}`)
        expect(g2.targetLabel).toBe(`공개 프로필 @${A.display!.handle} (표시명)`)
        expect(JSON.stringify(g2)).not.toContain(A.real.handle)
      })
    },
    DB_TIMEOUT,
  )

  it(
    '§6.2 analytics: user key only, hour-truncated, no persona ids/handles/counterpart keys, opt-out respected',
    async () => {
      setAnalyticsEnvForTesting(PEPPER)
      await withRollback(async (tx) => {
        const A = await makePerson(tx, { display: true })
        const B = await makePerson(tx, { display: true })
        const pepper = analyticsPepper()!
        const keyOf = (userId: string) => hashSubject(pepper, userId)
        const eventsOf = async (userId: string) => tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, keyOf(userId)))
        const minute = new Date('2026-11-12T09:37:12Z')
        // 비공개 계정에 팔로우 요청 → 승인, 공개 범위, 연결, 차단·뮤트, 팔로워 삭제, 피드 열기.
        await updatePersona(tx, B.actor, B.display!.id, { accountPrivacy: 'private' }, minute)
        await followProfile(tx, A.actor, B.display!.handle, { as: A.display!.id, origin: 'suggestion' }, minute)
        const incoming = (await getMyFollows(tx, B.actor, B.display!.id)).incoming[0]!
        await approveFollowRequest(tx, B.actor, incoming.id, minute)
        await setVisibility(tx, A.actor, A.display!.id, { items: { posts: 'signed_in' } }, minute)
        await setIdentityLink(tx, A.actor, { visible: true }, minute)
        await createMute(tx, A.actor, { handle: B.real.handle }, minute)
        await createBlock(tx, A.actor, { handle: B.real.handle, as: A.real.id, scope: 'origin_persona' }, minute)
        await followProfile(tx, B.actor, A.display!.handle, { as: B.real.id }, minute)
        const follower = (await getMyFollows(tx, A.actor, A.display!.id)).followers.find((f) => f.handle === B.real.handle)!
        await removeFollower(tx, A.actor, follower.id, minute)
        await createProfilePost(tx, B.actor, B.display!.id, { body: '피드 글' }, minute)
        const feedItem = (await getFeed(tx, A.actor)).items[0]!
        await recordFeedItemOpened(tx, A.actor, { activityId: feedItem.id }, minute)
        await expectServiceError(recordFeedItemOpened(tx, A.actor, { activityId: 'nope' }, minute), 'VALIDATION')

        const aEvents = await eventsOf(A.userId)
        const names = aEvents.map((e) => e.name).sort()
        expect(names).toEqual(
          expect.arrayContaining([
            'persona_created',
            'follow_requested',
            'visibility_changed',
            'identity_link_toggled',
            'mute_created',
            'block_created',
            'follower_removed',
            'feed_item_opened',
          ]),
        )
        expect(aEvents.filter((e) => e.name === 'persona_created').map((e) => e.props.kind).sort()).toEqual(['display', 'real'])
        expect(aEvents.find((e) => e.name === 'follow_requested')!.props).toEqual({ origin: 'suggestion', pending: true, targetKind: 'display' })
        expect(aEvents.find((e) => e.name === 'visibility_changed')!.props).toEqual({ audience: 'signed_in', itemKind: 'posts' })
        expect(aEvents.find((e) => e.name === 'block_created')!.props).toEqual({ scope: 'origin_persona' })
        expect(aEvents.find((e) => e.name === 'feed_item_opened')!.props).toEqual({ sourceType: 'profile_post' })
        expect((await eventsOf(B.userId)).find((e) => e.name === 'follow_approved')!.props).toEqual({ bulk: false })
        // 시 단위 시각, 프로젝트 키 없음.
        for (const e of aEvents.filter((x) => x.name !== 'persona_created')) {
          expect(e.occurredAt.toISOString(), e.name).toBe('2026-11-12T09:00:00.000Z')
          expect(e.projectHash).toBeNull()
        }
        // 페르소나 id·handle·이름·상대방 키 0건(모든 사람의 이벤트에서).
        const all = await tx.select().from(analyticsEvents).where(inArray(analyticsEvents.actorHash, [keyOf(A.userId), keyOf(B.userId)]))
        expectNone(
          all.map((e) => e.props),
          [A.real.id, A.display!.id, B.real.id, B.display!.id, A.real.handle, A.display!.handle, B.real.handle, B.display!.handle, A.userId, B.userId, keyOf(A.userId), keyOf(B.userId)],
        )
        // 상대방(B)의 키로는 A가 한 차단·뮤트·팔로워 삭제가 남지 않습니다.
        expect((await eventsOf(B.userId)).map((e) => e.name)).not.toEqual(expect.arrayContaining(['block_created']))

        // 수집 거부: 지난 이벤트 삭제, 이후 이벤트 없음.
        await setAnalyticsOptOut(tx, A.actor, { analyticsOptOut: true })
        expect(await eventsOf(A.userId)).toEqual([])
        await recordFeedItemOpened(tx, A.actor, { activityId: feedItem.id }, minute)
        await setVisibility(tx, A.actor, A.display!.id, { items: { posts: 'public' } }, minute)
        expect(await eventsOf(A.userId)).toEqual([])
      })
    },
    DB_TIMEOUT,
  )

  it(
    'operator metrics: profile section from events and operational records, every cell below 5 suppressed',
    async () => {
      setAnalyticsEnvForTesting(PEPPER)
      await withRollback(async (tx) => {
        const O = await makeOperator(tx)
        // 다른 데이터와 섞이지 않게 먼 미래 기간에 이벤트를 만듭니다.
        const when = new Date('2031-05-14T03:00:00Z')
        const people = await Promise.all(Array.from({ length: 6 }, () => createUser(tx, { displayName: '지표' })))
        const pepper = analyticsPepper()!
        type Row = typeof analyticsEvents.$inferInsert
        const ev = (name: Row['name'], userId: string, props: Record<string, string>): Row => ({ name, actorHash: hashSubject(pepper, userId), hashKeyId: '00000000', props, occurredAt: when })
        const rows: Row[] = people.flatMap((p, i) => [
          ev('feed_item_opened', p.id, { sourceType: 'senior_note' }),
          ...(i < 5 ? [ev('usefulness_marked', p.id, { target: 'senior_note', kind: 'helped' })] : []),
          ...(i < 3 ? [ev('block_created', p.id, { scope: 'origin_persona' })] : []),
        ])
        await tx.insert(analyticsEvents).values(rows)
        const m = await getOperatorMetrics(tx, O, { from: '2031-05-01', to: '2031-05-31' }, new Date('2031-06-01T00:00:00Z'))
        expect(m.profile.feedUsers).toBe(6)
        expect(m.profile.followToRecord).toEqual({ numerator: 5, denominator: 6, rate: 0.833 })
        expect(m.profile.feedComposition).toEqual({ numerator: 6, denominator: 6, rate: 1 })
        expect(m.profile.relationRemovals.blocks).toBeNull()
        expect(m.profile.displayAdoption).toEqual({ numerator: null, denominator: null, rate: null })
        expect(m.profile.impersonation).toEqual({ reports: null, confirmed: null })
        expect(m.profile.ownerLookups).toBeNull()
        expectNone(m.profile, people.map((p) => p.id))
        const inRange = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(analyticsEvents)
          .where(and(gte(analyticsEvents.occurredAt, new Date('2031-05-01T00:00:00Z')), lt(analyticsEvents.occurredAt, new Date('2031-06-01T00:00:00Z'))))
        expect(inRange[0]!.n).toBe(rows.length)
      })
    },
    DB_TIMEOUT,
  )
})
