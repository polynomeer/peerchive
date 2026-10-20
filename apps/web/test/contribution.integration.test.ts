/**
 * T-08 역할 선언·팀원 확인·기여 장부 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 프로젝트의 행만 셉니다(개발 DB에 남은 행과 무관).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { CLAIM_LIMIT_PER_MEMBER } from '@peerchive/domain'
import { and, artifactVersions, artifacts, auditEvents, eq, projects, type DbExecutor } from '@peerchive/db'
import {
  createClaim,
  listClaimRevisions,
  listClaims,
  reviseClaim,
  setEndorsement,
  withdrawEndorsement,
} from '../server/modules/contribution/claims'
import { getContribution } from '../server/modules/contribution/ledger'
import { formatWeeklySummary } from '../server/modules/contribution/weekly-summary'
import { createLog, reviseLog } from '../server/modules/logs/logs'
import { createMilestone, addSnapshot } from '../server/modules/milestones/milestones'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { leaveProject } from '../server/modules/projects/members'
import { createProject } from '../server/modules/projects/projects'
import { completeTask, createTask } from '../server/modules/tasks/tasks'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

/** 2026-11-02(월) 18:00 KST. 그 주는 11-02 ~ 11-08. */
const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const WEEK = { from: '2026-11-02', to: '2026-11-08' }

type Role = 'editor' | 'reviewer' | 'viewer'

async function team(db: DbExecutor, members: Array<{ role: Role; name: string }>, ownerName = '소유자') {
  const owner = await createUser(db, { displayName: ownerName })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' })
  // 주차 계산 기준(만든 주 = 1주차)을 테스트 시각에 맞춥니다.
  await db.update(projects).set({ createdAt: T0 }).where(eq(projects.id, project.id))
  const users: Array<{ id: string; email: string }> = []
  for (const { role, name } of members) {
    const user = await createUser(db, { displayName: name })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    users.push(user)
  }
  return { owner, project, users }
}

async function fileVersion(
  db: DbExecutor,
  projectId: string,
  uploaderId: string,
  scanStatus: 'pending' | 'clean' | 'quarantined' | 'failed',
  createdAt = T0,
) {
  const [artifact] = await db.insert(artifacts).values({ projectId, uploaderId, title: `${scanStatus}.pdf` }).returning()
  const [version] = await db
    .insert(artifactVersions)
    .values({
      artifactId: artifact!.id,
      versionNo: 1,
      uploaderId,
      fileName: `${scanStatus}.pdf`,
      declaredType: 'application/pdf',
      mediaType: 'application/pdf',
      bytes: 10,
      sha256: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
      objectKey: `clean/${crypto.randomUUID()}`,
      scanStatus,
      createdAt,
    })
    .returning()
  return version!
}

const progress = (body: string) => ({ tag: 'progress', body })

describe.skipIf(!databaseUrl)('role claims, endorsements and contribution ledger (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('members declare their own claims; viewers get FORBIDDEN, non-members NOT_FOUND; owner cannot revise others', async () => {
    await withRollback(async (tx) => {
      const { owner, project, users } = await team(tx, [
        { role: 'editor', name: '에디터' },
        { role: 'reviewer', name: '리뷰어' },
        { role: 'viewer', name: '뷰어' },
      ])
      const [editor, reviewer, viewer] = users
      const stranger = await createUser(tx)

      const claim = await createClaim(tx, { userId: editor!.id }, project.id, { text: '  API 입력 검증 담당 ' }, T0)
      expect(claim).toMatchObject({
        projectId: project.id,
        author: { userId: editor!.id, displayName: '에디터' },
        authorActive: true,
        revisionNo: 1,
        revisionCount: 1,
        text: 'API 입력 검증 담당',
        status: 'unconfirmed',
        confirmedCount: 0,
        evidence: [],
        endorsements: [],
        canRevise: true,
        canEndorse: false,
        myEndorsement: null,
      })
      // reviewer도 자기 역할(리뷰)을 선언할 수 있습니다.
      await createClaim(tx, { userId: reviewer!.id }, project.id, { text: '코드 리뷰' }, T0)

      await expectServiceError(createClaim(tx, { userId: viewer!.id }, project.id, { text: 'x' }), 'FORBIDDEN')
      await expectServiceError(createClaim(tx, { userId: stranger.id }, project.id, { text: 'x' }), 'NOT_FOUND')
      await expectServiceError(listClaims(tx, { userId: stranger.id }, project.id), 'NOT_FOUND')
      await expectServiceError(listClaimRevisions(tx, { userId: stranger.id }, claim.id), 'NOT_FOUND')
      await expectServiceError(
        reviseClaim(tx, { userId: stranger.id }, claim.id, { expectedRevision: 1, text: 'x' }),
        'NOT_FOUND',
      )
      await expectServiceError(
        getContribution(tx, { userId: stranger.id }, project.id, {}, T0),
        'NOT_FOUND',
      )

      // owner도 남의 선언은 고칠 수 없습니다.
      await expectServiceError(reviseClaim(tx, { userId: owner.id }, claim.id, { expectedRevision: 1, text: '빼앗기' }), 'FORBIDDEN')
      await expectServiceError(reviseClaim(tx, { userId: viewer!.id }, claim.id, { expectedRevision: 1, text: 'x' }), 'FORBIDDEN')

      // viewer는 읽을 수 있고 확인은 못 합니다.
      const seenByViewer = await listClaims(tx, { userId: viewer!.id }, project.id)
      expect(seenByViewer.map((c) => c.text)).toEqual(['코드 리뷰', 'API 입력 검증 담당'])
      expect(seenByViewer.every((c) => !c.canEndorse && !c.canRevise)).toBe(true)
      await expectServiceError(
        setEndorsement(tx, { userId: viewer!.id }, claim.revisionId, { status: 'confirmed' }),
        'FORBIDDEN',
      )
      await expectServiceError(withdrawEndorsement(tx, { userId: viewer!.id }, claim.revisionId), 'FORBIDDEN')
      await expectServiceError(
        setEndorsement(tx, { userId: stranger.id }, claim.revisionId, { status: 'confirmed' }),
        'NOT_FOUND',
      )
      await expectServiceError(listClaims(tx, { userId: owner.id }, 'not-a-uuid'), 'NOT_FOUND')

      // 입력 검증
      const fieldsOf = async (input: unknown) =>
        (await expectServiceError(createClaim(tx, { userId: owner.id }, project.id, input), 'VALIDATION')).fields
      expect(await fieldsOf({})).toEqual({ text: 'required' })
      expect(await fieldsOf({ text: '가'.repeat(301) })).toEqual({ text: 'too_long' })
      expect(await fieldsOf({ text: 'x', evidence: [{ kind: 'file', id: crypto.randomUUID() }] })).toEqual({
        'evidence.0.kind': 'invalid',
      })
      expect(
        await fieldsOf({ text: 'x', evidence: Array.from({ length: 21 }, () => ({ kind: 'log', id: crypto.randomUUID() })) }),
      ).toEqual({ evidence: 'too_many' })

      const audit = await tx
        .select({ action: auditEvents.action, metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(and(eq(auditEvents.projectId, project.id), eq(auditEvents.action, 'claim.create')))
      expect(audit).toHaveLength(2)
      expect(JSON.stringify(audit)).not.toContain('API 입력')
    })
  })

  it('limits claims per member and validates evidence (same project, no quarantined files, pending shown)', async () => {
    await withRollback(async (tx) => {
      const { owner, project, users } = await team(tx, [{ role: 'editor', name: '에디터' }])
      const [editor] = users
      const other = await team(tx, [])
      const actor = { userId: editor!.id }

      const log = await createLog(tx, actor, project.id, progress('로그인 API 구현'), T0)
      const foreignLog = await createLog(tx, { userId: other.owner.id }, other.project.id, progress('남의 로그'), T0)
      const pending = await fileVersion(tx, project.id, owner.id, 'pending')
      const quarantined = await fileVersion(tx, project.id, owner.id, 'quarantined')
      const failed = await fileVersion(tx, project.id, owner.id, 'failed')
      const foreignFile = await fileVersion(tx, other.project.id, other.owner.id, 'clean')

      const evidenceError = async (evidence: unknown) =>
        (await expectServiceError(createClaim(tx, actor, project.id, { text: 'x', evidence }), 'VALIDATION')).fields
      expect(await evidenceError([{ kind: 'log', id: foreignLog.log.id }])).toEqual({ evidence: 'not_found' })
      expect(await evidenceError([{ kind: 'artifact', id: foreignFile.id }])).toEqual({ evidence: 'not_found' })
      expect(await evidenceError([{ kind: 'log', id: crypto.randomUUID() }])).toEqual({ evidence: 'not_found' })
      // 산출물 버전 id를 로그로(또는 반대로) 보내도 찾을 수 없습니다.
      expect(await evidenceError([{ kind: 'log', id: pending.id }])).toEqual({ evidence: 'not_found' })
      expect(await evidenceError([{ kind: 'artifact', id: quarantined.id }])).toEqual({ evidence: 'not_attachable' })
      expect(await evidenceError([{ kind: 'artifact', id: failed.id }])).toEqual({ evidence: 'not_attachable' })

      const claim = await createClaim(
        tx,
        actor,
        project.id,
        {
          text: '로그인 기능',
          evidence: [
            { kind: 'artifact', id: pending.id },
            { kind: 'log', id: log.log.id },
            { kind: 'log', id: log.log.id },
          ],
        },
        T0,
      )
      expect(claim.evidence).toEqual([
        expect.objectContaining({ kind: 'artifact', versionId: pending.id, scanStatus: 'pending', contentUrl: null }),
        expect.objectContaining({ kind: 'log', logId: log.log.id, tag: 'progress', summary: '로그인 API 구현', revisionNo: 1, currentRevisionNo: 1 }),
      ])

      // 로그를 고친 뒤에도 근거는 선언할 때의 revision을 가리킵니다.
      await reviseLog(tx, actor, log.log.id, { expectedRevision: 1, body: '로그인 API 구현(토큰 갱신 포함)' }, at(5))
      const [reread] = await listClaims(tx, actor, project.id)
      expect(reread!.evidence[1]).toMatchObject({ kind: 'log', revisionNo: 1, currentRevisionNo: 2, summary: '로그인 API 구현' })

      for (let i = 1; i < CLAIM_LIMIT_PER_MEMBER; i++) await createClaim(tx, actor, project.id, { text: `선언 ${i}` }, T0)
      const limit = await expectServiceError(createClaim(tx, actor, project.id, { text: '하나 더' }), 'CONFLICT', 'limit_reached')
      expect(limit.details).toEqual({ limit: CLAIM_LIMIT_PER_MEMBER })
      // 한도는 멤버별입니다.
      await createClaim(tx, { userId: owner.id }, project.id, { text: 'owner 선언' }, T0)
    })
  })

  it('revisions reset confirmations, reject stale writes and keep the history per revision', async () => {
    await withRollback(async (tx) => {
      const { project, users } = await team(tx, [
        { role: 'editor', name: 'A' },
        { role: 'editor', name: 'B' },
      ])
      const [a, b] = users
      const log = await createLog(tx, { userId: a!.id }, project.id, progress('스키마 설계'), T0)
      const claim = await createClaim(tx, { userId: a!.id }, project.id, { text: 'DB 설계', evidence: [{ kind: 'log', id: log.log.id }] }, T0)

      // 자기 확인 불가
      await expectServiceError(
        setEndorsement(tx, { userId: a!.id }, claim.revisionId, { status: 'confirmed' }),
        'FORBIDDEN',
        'self_endorsement',
      )

      const confirmed = await setEndorsement(tx, { userId: b!.id }, claim.revisionId, { status: 'confirmed', note: '함께 확인함' }, at(1))
      expect(confirmed).toMatchObject({ status: 'confirmed', confirmedCount: 1, myEndorsement: 'confirmed' })
      expect(confirmed.endorsements).toEqual([
        expect.objectContaining({ endorser: { userId: b!.id, displayName: 'B', handle: null }, status: 'confirmed', note: '함께 확인함' }),
      ])
      // A가 보면 확인 1명, 확인 버튼 없음
      const [seenByA] = await listClaims(tx, { userId: a!.id }, project.id)
      expect(seenByA).toMatchObject({ status: 'confirmed', confirmedCount: 1, canEndorse: false, canRevise: true, myEndorsement: null })

      // 바뀐 것이 없으면 거부, 낡은 revision은 409
      const same = await expectServiceError(reviseClaim(tx, { userId: a!.id }, claim.id, { expectedRevision: 1 }), 'VALIDATION')
      expect(same.fields).toEqual({ _: 'no_changes' })
      const revised = await reviseClaim(tx, { userId: a!.id }, claim.id, { expectedRevision: 1, text: 'DB 설계와 migration' }, at(2))
      expect(revised).toMatchObject({
        revisionNo: 2,
        revisionCount: 2,
        text: 'DB 설계와 migration',
        status: 'unconfirmed',
        confirmedCount: 0,
        endorsements: [],
      })
      // 근거는 생략하면 이어받습니다.
      expect(revised.evidence).toEqual([expect.objectContaining({ kind: 'log', logId: log.log.id })])
      const stale = await expectServiceError(
        reviseClaim(tx, { userId: a!.id }, claim.id, { expectedRevision: 1, text: '덮어쓰기' }),
        'CONFLICT',
        'stale_revision',
      )
      expect(stale.details).toEqual({ currentRevision: 2 })

      // 이전 revision에 확인하거나 철회하면 409 not_current
      const old = await expectServiceError(
        setEndorsement(tx, { userId: b!.id }, claim.revisionId, { status: 'confirmed' }),
        'CONFLICT',
        'not_current',
      )
      expect(old.details).toEqual({ currentRevisionId: revised.revisionId })
      await expectServiceError(withdrawEndorsement(tx, { userId: b!.id }, claim.revisionId), 'CONFLICT', 'not_current')

      // 근거만 바꿔도 새 revision이며, 비울 수도 있습니다.
      const cleared = await reviseClaim(tx, { userId: a!.id }, claim.id, { expectedRevision: 2, evidence: [] }, at(3))
      expect(cleared).toMatchObject({ revisionNo: 3, evidence: [], text: 'DB 설계와 migration' })

      const history = await listClaimRevisions(tx, { userId: b!.id }, claim.id)
      expect(history.map((r) => [r.revisionNo, r.status, r.current, r.endorsements.length, r.evidence.length])).toEqual([
        [1, 'confirmed', false, 1, 1],
        [2, 'unconfirmed', false, 0, 1],
        [3, 'unconfirmed', true, 0, 0],
      ])
      expect(history[0]!.endorsements[0]).toMatchObject({ endorser: { userId: b!.id }, status: 'confirmed' })
    })
  })

  it('a dispute wins over confirmations; endorsements can be changed and withdrawn', async () => {
    await withRollback(async (tx) => {
      const { owner, project, users } = await team(tx, [
        { role: 'editor', name: 'A' },
        { role: 'editor', name: 'B' },
        { role: 'reviewer', name: 'R' },
      ])
      const [a, b, r] = users
      const claim = await createClaim(tx, { userId: a!.id }, project.id, { text: '발표 자료 전체 제작' }, T0)

      await setEndorsement(tx, { userId: owner.id }, claim.revisionId, { status: 'confirmed' }, at(1))
      await setEndorsement(tx, { userId: r!.id }, claim.revisionId, { status: 'confirmed' }, at(1))
      const noNote = await expectServiceError(
        setEndorsement(tx, { userId: b!.id }, claim.revisionId, { status: 'disputed' }),
        'VALIDATION',
      )
      expect(noNote.fields).toEqual({ note: 'required' })
      const disputed = await setEndorsement(
        tx,
        { userId: b!.id },
        claim.revisionId,
        { status: 'disputed', note: '표지와 3장은 B가 만들었습니다(로그 11/2 참고).' },
        at(2),
      )
      expect(disputed).toMatchObject({ status: 'disputed', confirmedCount: 2, disputedCount: 1, myEndorsement: 'disputed' })

      // B가 이의를 확인으로 바꾸면 확인 3명
      const changed = await setEndorsement(tx, { userId: b!.id }, claim.revisionId, { status: 'confirmed' }, at(3))
      expect(changed).toMatchObject({ status: 'confirmed', confirmedCount: 3, disputedCount: 0 })
      expect(changed.endorsements.find((e) => e.endorser.userId === b!.id)).toMatchObject({ note: null })

      // 철회(두 번 해도 204)
      await withdrawEndorsement(tx, { userId: b!.id }, claim.revisionId)
      await withdrawEndorsement(tx, { userId: b!.id }, claim.revisionId)
      const [after] = await listClaims(tx, { userId: b!.id }, project.id)
      expect(after).toMatchObject({ confirmedCount: 2, myEndorsement: null })

      const actions = await tx
        .select({ action: auditEvents.action, metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(eq(auditEvents.projectId, project.id))
      const names = actions.map((e) => e.action)
      expect(names.filter((n) => n === 'endorsement.set')).toHaveLength(4)
      expect(names.filter((n) => n === 'endorsement.withdraw')).toHaveLength(1)
      expect(JSON.stringify(actions)).not.toContain('표지와')
    })
  })

  it('builds a period ledger: kinds/counts per member, name order, only this project, no emails', async () => {
    await withRollback(async (tx) => {
      const { owner, project, users } = await team(
        tx,
        [
          { role: 'editor', name: '하늘' },
          { role: 'editor', name: '가람' },
          { role: 'viewer', name: '나래' },
          { role: 'editor', name: '떠난이' },
          { role: 'editor', name: '조용히떠남' },
        ],
        '다온',
      )
      const [haneul, garam, narae, leaver, quietLeaver] = users
      const other = await team(tx, [])
      const H = { userId: haneul!.id }
      const G = { userId: garam!.id }

      // 하늘: 이번 주 진행 3, 막힘 2(1개 해결), 결정 1. 지난주 일요일 밤(KST)·다음 주 월요일 로그는 제외.
      for (let i = 0; i < 3; i++) await createLog(tx, H, project.id, progress(`진행 ${i}`), at(i))
      const stuck1 = await createLog(tx, H, project.id, { tag: 'stuck', payload: { symptom: 'CORS 에러', timeBucket: 'lt2h' } }, at(10))
      await createLog(tx, H, project.id, { tag: 'stuck', payload: { symptom: '지도 API 쿼터 초과', timeBucket: 'lt2h' } }, at(11))
      await createLog(
        tx,
        H,
        project.id,
        { tag: 'decision', payload: { options: ['A', 'B'], criteria: '비용', choice: 'A' } },
        at(12),
      )
      await createLog(tx, H, project.id, progress('지난주'), new Date('2026-11-01T14:59:00Z'))
      await createLog(tx, H, project.id, progress('다음 주'), new Date('2026-11-08T15:00:00Z'))
      // 가람: 해결 1(하늘의 막힘), 회의 1(참석: 하늘·가람·떠난이), 할 일 완료 1, clean 파일 1(+ 격리 파일은 제외)
      await createLog(
        tx,
        G,
        project.id,
        { tag: 'solution', payload: { method: '프록시 설정', notAnswerConfirmed: true }, resolvesEntryId: stuck1.log.id },
        at(20),
      )
      await createLog(
        tx,
        G,
        project.id,
        { tag: 'meeting', body: '주간 회의', payload: { attendees: [haneul!.id, garam!.id, leaver!.id] } },
        at(21),
      )
      const task = await createTask(tx, G, project.id, { title: '와이어프레임' }, T0)
      await completeTask(tx, G, task.id, { expectedVersion: task.version }, at(30))
      await fileVersion(tx, project.id, garam!.id, 'clean', at(31))
      await fileVersion(tx, project.id, garam!.id, 'quarantined', at(32))
      await createClaim(tx, G, project.id, { text: 'UI 설계' }, at(40))
      // 떠난이: 이번 주 로그를 남기고 나감 → 포함. 조용히떠남: 기록 없이 나감 → 제외.
      await createLog(tx, { userId: leaver!.id }, project.id, progress('인수인계 문서'), at(50))
      await leaveProject(tx, { userId: leaver!.id }, project.id)
      await leaveProject(tx, { userId: quietLeaver!.id }, project.id)
      // 다른 프로젝트의 기록은 섞이지 않습니다.
      for (let i = 0; i < 5; i++) await createLog(tx, { userId: other.owner.id }, other.project.id, progress(`남의 ${i}`), at(i))
      // 마일스톤과 이번 주 스냅샷
      const milestone = await createMilestone(tx, { userId: owner.id }, project.id, { title: '중간발표', dueAt: '2026-11-10' }, T0)
      const snap = await fileVersion(tx, project.id, owner.id, 'clean', at(60))
      await addSnapshot(tx, { userId: owner.id }, milestone.id, { artifactVersionId: snap.id }, at(61))

      const ledger = await getContribution(tx, { userId: narae!.id }, project.id, WEEK, at(24 * 60))
      expect(ledger.period).toEqual({ ...WEEK, timeZone: 'Asia/Seoul', weekNo: 1 })
      expect(ledger.members.map((m) => [m.member.displayName, m.active])).toEqual([
        ['가람', true],
        ['나래', true],
        ['다온', true],
        ['떠난이', false],
        ['하늘', true],
      ])
      const row = (name: string) => ledger.members.find((m) => m.member.displayName === name)!
      expect(row('하늘')).toMatchObject({
        logCounts: { progress: 3, stuck: 2, solution: 0, decision: 1, meeting: 0, validation: 0, retro: 0 },
        stuckResolved: 1,
        tasksCompleted: 0,
        artifactsUploaded: 0,
        meetingsAttended: 1,
        claims: [],
      })
      expect(row('가람')).toMatchObject({
        logCounts: { solution: 1, meeting: 1, progress: 0 },
        tasksCompleted: 1,
        artifactsUploaded: 1,
        meetingsAttended: 1,
      })
      expect(row('가람').claims.map((c) => [c.text, c.status])).toEqual([['UI 설계', 'unconfirmed']])
      expect(row('떠난이')).toMatchObject({ logCounts: { progress: 1 }, meetingsAttended: 1 })
      expect(row('다온')).toMatchObject({ artifactsUploaded: 1 })
      expect(row('나래').logCounts.progress).toBe(0)
      expect(ledger.unresolvedStuck.map((s) => [s.summary, s.author.displayName, s.openDays])).toEqual([
        ['지도 API 쿼터 초과', '하늘', 2],
      ])
      expect(ledger.milestone).toEqual({ title: '중간발표', dueAt: '2026-11-10', snapshotsInPeriod: 1 })
      expect(ledger.disclaimer).toBe('※ 개수는 참고용이며 기여의 크기를 뜻하지 않습니다.')

      // 리포트 데이터에 이메일·다른 프로젝트 내용이 없습니다.
      const json = JSON.stringify(ledger)
      for (const u of [owner, ...users, other.owner]) expect(json).not.toContain(u.email)
      expect(json).not.toContain('남의')
      expect(json).not.toContain(other.project.id)

      // 요약 문장은 이름순 그대로
      const text = formatWeeklySummary(ledger)
      expect(text.split('\n')[0]).toBe('[캡스톤 디자인] 주간 기여 요약 — 1주차 (11-02 ~ 11-08)')
      expect(text).toContain('하늘  🔨진행 3 · 🧱막힘 2(해결 1) · ⚖️결정 1 · 👥회의 참석 1')

      // 지난주: 하늘의 일요일 밤 로그 1건만. 이번 주 막힘은 아직 없었으므로 미해결 목록도 비어 있습니다.
      const lastWeek = await getContribution(tx, H, project.id, { from: '2026-10-26', to: '2026-11-01' }, at(24 * 60))
      expect(lastWeek.period.weekNo).toBeNull()
      expect(lastWeek.members.find((m) => m.member.userId === haneul!.id)!.logCounts.progress).toBe(1)
      expect(lastWeek.members.map((m) => m.member.displayName)).toEqual(['가람', '나래', '다온', '하늘'])
      expect(lastWeek.unresolvedStuck).toEqual([])

      // 기본 기간은 now가 속한 주(서울).
      const current = await getContribution(tx, H, project.id, {}, new Date('2026-11-08T14:30:00Z'))
      expect(current.period).toMatchObject(WEEK)
      // 하루짜리 기간도 같은 규칙(해결 로그가 기간 끝 전에 생김).
      const tooEarly = await getContribution(tx, H, project.id, { from: '2026-11-02', to: '2026-11-02' }, at(24 * 60))
      expect(tooEarly.members.find((m) => m.member.userId === haneul!.id)!.stuckResolved).toBe(1)

      const bad = async (query: unknown) =>
        (await expectServiceError(getContribution(tx, H, project.id, query, T0), 'VALIDATION')).fields
      expect(await bad({ from: '2026-11-08', to: '2026-11-02' })).toEqual({ to: 'before_from' })
      expect(await bad({ from: '2025-01-01', to: '2026-11-02' })).toEqual({ to: 'too_long' })
      expect(await bad({ from: '2026-11-02' })).toEqual({ to: 'required' })
      expect(await bad({ from: '2026-13-01', to: '2026-11-02' })).toEqual({ from: 'invalid_format' })
    })
  })
})
