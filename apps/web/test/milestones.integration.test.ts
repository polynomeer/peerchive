/**
 * T-06 마일스톤·스냅샷·로그 연결 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 산출물 버전은 업로드·검사 과정(T-05 테스트에서 다룸) 대신 원하는 검사 상태로 바로 넣습니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { MILESTONE_LIMIT, SNAPSHOT_LIMIT } from '@peerchive/domain'
import { artifactVersions, artifacts, auditEvents, eq, milestones, type DbExecutor } from '@peerchive/db'
import { createLog, listLogRevisions, listLogs, reviseLog } from '../server/modules/logs/logs'
import {
  addSnapshot,
  applyMilestoneTemplate,
  createMilestone,
  deleteMilestone,
  listMilestones,
  removeSnapshot,
  reorderMilestones,
  updateMilestone,
} from '../server/modules/milestones/milestones'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))

async function teamWith(db: DbExecutor, ...roles: Array<'editor' | 'reviewer' | 'viewer'>) {
  const owner = await createUser(db, { displayName: '소유자' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' })
  const members = []
  for (const role of roles) {
    const user = await createUser(db, { displayName: role })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members.push(user)
  }
  return { owner, project, members }
}

let sequence = 0
/** 검사 상태를 정해 산출물 버전 하나를 바로 넣습니다. */
async function versionWith(
  db: DbExecutor,
  projectId: string,
  uploaderId: string,
  scanStatus: 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed',
  mediaType = 'image/png',
) {
  sequence += 1
  const [artifact] = await db
    .insert(artifacts)
    .values({ projectId, uploaderId, title: `화면 ${sequence}.png` })
    .returning({ id: artifacts.id })
  const [version] = await db
    .insert(artifactVersions)
    .values({
      artifactId: artifact!.id,
      versionNo: 1,
      uploaderId,
      fileName: `화면 ${sequence}.png`,
      declaredType: mediaType,
      mediaType: scanStatus === 'clean' ? mediaType : null,
      bytes: 100,
      sha256: sequence.toString(16).padStart(64, '0'),
      objectKey: `clean/${crypto.randomUUID()}`,
      scanStatus,
    })
    .returning({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
  return version!
}

const titles = (list: Array<{ title: string }>) => list.map((m) => m.title)
const positions = (list: Array<{ position: number }>) => list.map((m) => m.position)

describe.skipIf(!databaseUrl)('milestones, snapshots and log links (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('owner/editor create milestones in order; reviewer/viewer read but get FORBIDDEN on writes; non-members NOT_FOUND', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor', 'reviewer', 'viewer')
      const [editor, reviewer, viewer] = members
      const stranger = await createUser(tx)

      const first = await createMilestone(tx, { userId: owner.id }, project.id, {
        title: ' 기획 ',
        note: '주제 선정',
        dueAt: '2026-09-20',
        claimedAt: '2026-09-18',
      }, T0)
      expect(first).toMatchObject({
        projectId: project.id,
        position: 1,
        title: '기획',
        note: '주제 선정',
        dueAt: '2026-09-20',
        claimedAt: '2026-09-18',
        version: 1,
        logCount: 0,
        snapshots: [],
      })
      const second = await createMilestone(tx, { userId: editor!.id }, project.id, { title: '중간발표', note: '' }, T0)
      expect(second).toMatchObject({ position: 2, note: null, dueAt: null, claimedAt: null })

      for (const reader of [reviewer!, viewer!]) {
        expect(titles(await listMilestones(tx, { userId: reader.id }, project.id))).toEqual(['기획', '중간발표'])
        await expectServiceError(createMilestone(tx, { userId: reader.id }, project.id, { title: 'x' }), 'FORBIDDEN')
        await expectServiceError(
          updateMilestone(tx, { userId: reader.id }, first.id, { expectedVersion: 1, title: 'x' }),
          'FORBIDDEN',
        )
        await expectServiceError(deleteMilestone(tx, { userId: reader.id }, second.id), 'FORBIDDEN')
        await expectServiceError(
          reorderMilestones(tx, { userId: reader.id }, project.id, { milestoneIds: [second.id, first.id] }),
          'FORBIDDEN',
        )
        await expectServiceError(applyMilestoneTemplate(tx, { userId: reader.id }, project.id), 'FORBIDDEN')
      }

      const stranger$ = { userId: stranger.id }
      await expectServiceError(listMilestones(tx, stranger$, project.id), 'NOT_FOUND')
      await expectServiceError(createMilestone(tx, stranger$, project.id, { title: 'x' }), 'NOT_FOUND')
      await expectServiceError(updateMilestone(tx, stranger$, first.id, { expectedVersion: 1, title: 'x' }), 'NOT_FOUND')
      await expectServiceError(deleteMilestone(tx, stranger$, first.id), 'NOT_FOUND')
      await expectServiceError(addSnapshot(tx, stranger$, first.id, { artifactVersionId: crypto.randomUUID() }), 'NOT_FOUND')
      await expectServiceError(removeSnapshot(tx, stranger$, first.id, crypto.randomUUID()), 'NOT_FOUND')
      await expectServiceError(listMilestones(tx, { userId: owner.id }, 'not-a-uuid'), 'NOT_FOUND')
      await expectServiceError(deleteMilestone(tx, { userId: owner.id }, crypto.randomUUID()), 'NOT_FOUND')

      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, first.id))
      expect(audits).toEqual([expect.objectContaining({ action: 'milestone.create', metadata: { position: 1 } })])
    })
  })

  it('validates input: title 1–80, note ≤500, real dates, claimedAt not beyond tomorrow', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const actor = { userId: owner.id }
      const fieldsOf = async (input: unknown) =>
        (await expectServiceError(createMilestone(tx, actor, project.id, input, T0), 'VALIDATION')).fields
      expect(await fieldsOf({})).toEqual({ title: 'required' })
      expect(await fieldsOf({ title: '  ' })).toEqual({ title: 'required' })
      expect(await fieldsOf({ title: '가'.repeat(81) })).toEqual({ title: 'too_long' })
      expect(await fieldsOf({ title: 'a', note: 'n'.repeat(501) })).toEqual({ note: 'too_long' })
      expect(await fieldsOf({ title: 'a', dueAt: '2026-02-30' })).toEqual({ dueAt: 'invalid_format' })
      expect(await fieldsOf({ title: 'a', claimedAt: '2026-11-04' })).toEqual({ claimedAt: 'too_far_future' })
      // 예정일은 미래여도 됩니다.
      expect((await createMilestone(tx, actor, project.id, { title: '가'.repeat(80), dueAt: '2027-06-30' }, T0)).dueAt).toBe(
        '2027-06-30',
      )
    })
  })

  it('limits milestones per project to 12 (409 limit_reached) and applies the template only to an empty project', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const actor = { userId: owner.id }
      const applied = await applyMilestoneTemplate(tx, actor, project.id, T0)
      expect(titles(applied)).toEqual(['기획', '중간발표', '구현', '검증', '최종제출'])
      expect(positions(applied)).toEqual([1, 2, 3, 4, 5])
      await expectServiceError(applyMilestoneTemplate(tx, actor, project.id, T0), 'CONFLICT', 'not_empty')

      for (let i = applied.length; i < MILESTONE_LIMIT; i++) await createMilestone(tx, actor, project.id, { title: `단계 ${i}` })
      const error = await expectServiceError(createMilestone(tx, actor, project.id, { title: '13번째' }), 'CONFLICT', 'limit_reached')
      expect(error.details).toEqual({ limit: MILESTONE_LIMIT })
      expect((await listMilestones(tx, actor, project.id)).length).toBe(MILESTONE_LIMIT)
    })
  })

  it('reorders only with a full permutation of current ids; positions stay contiguous', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const other = await teamWith(tx)
      const actor = { userId: owner.id }
      const [a, b, c] = await applyMilestoneTemplate(tx, actor, project.id).then((list) => list.slice(0, 3))
      const all = (await listMilestones(tx, actor, project.id)).map((m) => m.id)
      const foreign = await createMilestone(tx, { userId: other.owner.id }, other.project.id, { title: '남의 것' })

      const fieldsOf = async (milestoneIds: unknown) =>
        (await expectServiceError(reorderMilestones(tx, actor, project.id, { milestoneIds }), 'VALIDATION')).fields
      expect(await fieldsOf(all.slice(0, 4))).toEqual({ milestoneIds: 'mismatch' })
      expect(await fieldsOf([...all, crypto.randomUUID()])).toEqual({ milestoneIds: 'mismatch' })
      expect(await fieldsOf([foreign.id, ...all.slice(1)])).toEqual({ milestoneIds: 'mismatch' })
      expect(await fieldsOf([all[0], all[0], ...all.slice(2)])).toEqual({ milestoneIds: 'duplicate' })
      expect(await fieldsOf(undefined)).toEqual({ milestoneIds: 'required' })
      expect(await fieldsOf(['x'])).toEqual({ 'milestoneIds.0': 'invalid' })

      const reversed = [...all].reverse()
      const result = await reorderMilestones(tx, actor, project.id, { milestoneIds: reversed.map((id) => id.toUpperCase()) })
      expect(result.map((m) => m.id)).toEqual(reversed)
      expect(positions(result)).toEqual([1, 2, 3, 4, 5])
      // 순서 변경은 마일스톤 version을 올리지 않습니다.
      expect(result.every((m) => m.version === 1)).toBe(true)
      expect(titles(result)).toEqual(['최종제출', '검증', '구현', '중간발표', '기획'])
      expect([a, b, c].every(Boolean)).toBe(true)

      const reorders = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'milestone.reorder'))
      expect(reorders.filter((e) => e.projectId === project.id)).toHaveLength(1)
    })
  })

  it('updates with expectedVersion; a stale version is 409 version_conflict with currentVersion', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const editor = { userId: members[0]!.id }
      const m = await createMilestone(tx, { userId: owner.id }, project.id, { title: '중간발표', note: '슬라이드' })

      const updated = await updateMilestone(tx, editor, m.id, { expectedVersion: 1, title: '중간 발표', note: null, dueAt: '2026-10-20' }, T0)
      expect(updated).toMatchObject({ title: '중간 발표', note: null, dueAt: '2026-10-20', version: 2, position: 1 })
      // 생략한 필드는 그대로입니다.
      expect((await updateMilestone(tx, editor, m.id, { expectedVersion: 2, claimedAt: '2026-10-21' }, at(1)))).toMatchObject({
        title: '중간 발표',
        dueAt: '2026-10-20',
        claimedAt: '2026-10-21',
        version: 3,
      })

      const stale = await expectServiceError(
        updateMilestone(tx, { userId: owner.id }, m.id, { expectedVersion: 1, title: '덮어쓰기' }),
        'CONFLICT',
        'version_conflict',
      )
      expect(stale.details).toEqual({ currentVersion: 3 })
      expect((await expectServiceError(updateMilestone(tx, editor, m.id, { title: 'x' }), 'VALIDATION')).fields).toEqual({
        expectedVersion: 'required',
      })
      expect((await expectServiceError(updateMilestone(tx, editor, m.id, { expectedVersion: 3, title: '' }), 'VALIDATION')).fields).toEqual({
        title: 'required',
      })
    })
  })

  it('snapshots accept only clean versions of the same project; duplicates 409; at most 6; removal keeps order contiguous', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'viewer')
      const other = await teamWith(tx)
      const actor = { userId: owner.id }
      const m = await createMilestone(tx, actor, project.id, { title: '중간발표' })

      const clean = await versionWith(tx, project.id, owner.id, 'clean')
      const pdf = await versionWith(tx, project.id, owner.id, 'clean', 'application/pdf')
      const foreignClean = await versionWith(tx, other.project.id, other.owner.id, 'clean')

      const fieldsOf = async (artifactVersionId: unknown) =>
        (await expectServiceError(addSnapshot(tx, actor, m.id, { artifactVersionId }), 'VALIDATION')).fields
      for (const status of ['pending', 'scanning', 'quarantined', 'failed'] as const) {
        const version = await versionWith(tx, project.id, owner.id, status)
        expect(await fieldsOf(version.id)).toEqual({ artifactVersionId: 'not_clean' })
      }
      expect(await fieldsOf(foreignClean.id)).toEqual({ artifactVersionId: 'not_found' })
      expect(await fieldsOf(crypto.randomUUID())).toEqual({ artifactVersionId: 'not_found' })
      expect(await fieldsOf(undefined)).toEqual({ artifactVersionId: 'required' })
      expect(
        (await expectServiceError(addSnapshot(tx, actor, m.id, { artifactVersionId: clean.id, note: 'n'.repeat(301) }), 'VALIDATION'))
          .fields,
      ).toEqual({ note: 'too_long' })

      // viewer는 읽기만 합니다.
      await expectServiceError(addSnapshot(tx, { userId: members[0]!.id }, m.id, { artifactVersionId: clean.id }), 'FORBIDDEN')

      const withOne = await addSnapshot(tx, actor, m.id, { artifactVersionId: clean.id, note: '첫 화면' }, T0)
      expect(withOne.snapshots).toEqual([
        expect.objectContaining({
          artifactVersionId: clean.id,
          artifactId: clean.artifactId,
          scanStatus: 'clean',
          mediaType: 'image/png',
          contentUrl: `/api/v1/artifacts/${clean.artifactId}/versions/${clean.id}/content`,
          note: '첫 화면',
          position: 1,
        }),
      ])
      await expectServiceError(addSnapshot(tx, actor, m.id, { artifactVersionId: clean.id.toUpperCase() }), 'CONFLICT', 'duplicate')
      // 같은 버전을 다른 마일스톤에는 지정할 수 있습니다.
      const m2 = await createMilestone(tx, actor, project.id, { title: '최종' })
      expect((await addSnapshot(tx, actor, m2.id, { artifactVersionId: clean.id })).snapshots).toHaveLength(1)

      await addSnapshot(tx, actor, m.id, { artifactVersionId: pdf.id })
      const extra = []
      for (let i = 2; i < SNAPSHOT_LIMIT; i++) extra.push(await versionWith(tx, project.id, owner.id, 'clean'))
      for (const version of extra) await addSnapshot(tx, actor, m.id, { artifactVersionId: version.id })
      const overflow = await versionWith(tx, project.id, owner.id, 'clean')
      const limit = await expectServiceError(addSnapshot(tx, actor, m.id, { artifactVersionId: overflow.id }), 'CONFLICT', 'limit_reached')
      expect(limit.details).toEqual({ limit: SNAPSHOT_LIMIT })

      await removeSnapshot(tx, actor, m.id, pdf.id)
      const [after] = (await listMilestones(tx, actor, project.id)).filter((x) => x.id === m.id)
      expect(after!.snapshots.map((s) => s.artifactVersionId)).toEqual([clean.id, ...extra.map((v) => v.id)])
      expect(positions(after!.snapshots)).toEqual([1, 2, 3, 4, 5])
      await expectServiceError(removeSnapshot(tx, actor, m.id, pdf.id), 'NOT_FOUND')
      await expectServiceError(removeSnapshot(tx, { userId: members[0]!.id }, m.id, clean.id), 'FORBIDDEN')

      const snapshotAudits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, m.id))
      expect(snapshotAudits.map((e) => e.action)).toEqual(
        expect.arrayContaining(['milestone.create', 'milestone.snapshot_add', 'milestone.snapshot_remove']),
      )
    })
  })

  it('logs link to same-project milestones only (422 not_found otherwise), carry over on revise and filter by milestone', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const other = await teamWith(tx)
      const actor = { userId: owner.id }
      const [plan, midterm] = await applyMilestoneTemplate(tx, actor, project.id)
      const foreign = await createMilestone(tx, { userId: other.owner.id }, other.project.id, { title: '남의 것' })

      for (const milestoneId of [foreign.id, crypto.randomUUID()]) {
        const error = await expectServiceError(
          createLog(tx, actor, project.id, { tag: 'progress', body: '진행', milestoneId }, T0),
          'VALIDATION',
        )
        expect(error.fields).toEqual({ milestoneId: 'not_found' })
      }

      const { log } = await createLog(tx, actor, project.id, { tag: 'progress', body: '발표 준비', milestoneId: midterm!.id }, T0)
      expect(log.milestone).toEqual({ id: midterm!.id, position: 2, title: '중간발표' })
      const { log: free } = await createLog(tx, actor, project.id, { tag: 'progress', body: '마일스톤 없음' }, at(1))
      expect(free.milestone).toBeNull()

      // 생략하면 이어받고, 다른 마일스톤으로 바꾸거나 null로 비울 수 있습니다.
      const r2 = await reviseLog(tx, actor, log.id, { expectedRevision: 1, body: '발표 준비 완료' }, at(2))
      expect(r2.milestone?.id).toBe(midterm!.id)
      await expectServiceError(
        reviseLog(tx, actor, log.id, { expectedRevision: 2, milestoneId: foreign.id }, at(3)),
        'VALIDATION',
      )
      const r3 = await reviseLog(tx, actor, log.id, { expectedRevision: 2, milestoneId: plan!.id }, at(3))
      expect(r3).toMatchObject({ revisionNo: 3, milestone: { id: plan!.id, title: '기획' } })
      const r4 = await reviseLog(tx, actor, free.id, { expectedRevision: 1, milestoneId: midterm!.id }, at(4))
      expect(r4.milestone?.id).toBe(midterm!.id)
      expect((await expectServiceError(reviseLog(tx, actor, free.id, { expectedRevision: 2, milestoneId: midterm!.id }, at(5)), 'VALIDATION')).fields).toEqual({
        _: 'no_changes',
      })
      expect((await listLogRevisions(tx, actor, log.id)).map((r) => r.milestoneId)).toEqual([midterm!.id, midterm!.id, plan!.id])

      const byMilestone = async (milestone: string) =>
        (await listLogs(tx, actor, project.id, { milestone })).items.map((item) => item.id)
      expect(await byMilestone(midterm!.id)).toEqual([free.id])
      expect(await byMilestone(plan!.id)).toEqual([log.id])
      expect(await byMilestone(foreign.id)).toEqual([])
      await expectServiceError(listLogs(tx, actor, project.id, { milestone: 'x' }), 'VALIDATION')

      // 로그 수는 현재 revision 기준입니다.
      const counts = Object.fromEntries((await listMilestones(tx, actor, project.id)).map((m) => [m.title, m.logCount]))
      expect(counts).toMatchObject({ 기획: 1, 중간발표: 1, 구현: 0 })

      // 순서를 바꾸면 로그 DTO의 position도 지금 순서를 따릅니다.
      const ids = (await listMilestones(tx, actor, project.id)).map((m) => m.id)
      await reorderMilestones(tx, actor, project.id, { milestoneIds: [ids[1], ids[0], ...ids.slice(2)] })
      const [latest] = (await listLogs(tx, actor, project.id, { milestone: plan!.id })).items
      expect(latest!.milestone).toEqual({ id: plan!.id, position: 2, title: '기획' })
    })
  })

  it('delete: 409 in_use while any revision (even an earlier one) references it; otherwise removes snapshots and closes the gap', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const actor = { userId: owner.id }
      const list = await applyMilestoneTemplate(tx, actor, project.id)
      const [plan, midterm, build, check] = list
      const clean = await versionWith(tx, project.id, owner.id, 'clean')
      await addSnapshot(tx, actor, build!.id, { artifactVersionId: clean.id })

      const { log } = await createLog(tx, actor, project.id, { tag: 'progress', body: '기획서', milestoneId: plan!.id }, T0)
      const inUse = await expectServiceError(deleteMilestone(tx, actor, plan!.id), 'CONFLICT', 'in_use')
      expect(inUse.details).toEqual({ logCount: 1 })
      // 현재 revision이 다른 마일스톤으로 옮겨도 이전 revision이 가리키므로 지우지 않습니다(이력 보존).
      await reviseLog(tx, actor, log.id, { expectedRevision: 1, milestoneId: midterm!.id }, at(1))
      await expectServiceError(deleteMilestone(tx, actor, plan!.id), 'CONFLICT', 'in_use')

      // 스냅샷이 있는 마일스톤은 스냅샷과 함께 지워지고, 뒤 순서가 당겨집니다.
      await deleteMilestone(tx, actor, build!.id)
      const after = await listMilestones(tx, actor, project.id)
      expect(titles(after)).toEqual(['기획', '중간발표', '검증', '최종제출'])
      expect(positions(after)).toEqual([1, 2, 3, 4])
      await deleteMilestone(tx, actor, check!.id)
      const final = await listMilestones(tx, actor, project.id)
      expect(titles(final)).toEqual(['기획', '중간발표', '최종제출'])
      expect(positions(final)).toEqual([1, 2, 3])
      const left = await tx.select().from(milestones).where(eq(milestones.id, build!.id))
      expect(left).toEqual([])
      // 지운 뒤에도 마일스톤을 새로 만들면 마지막 순서에 붙습니다.
      expect((await createMilestone(tx, actor, project.id, { title: '회고' })).position).toBe(4)
      const deletes = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'milestone.delete'))
      expect(deletes.filter((e) => e.projectId === project.id).map((e) => e.metadata)).toEqual([{ position: 3 }, { position: 3 }])
    })
  })
})
