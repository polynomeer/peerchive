/**
 * T-07 할 일·완료 → 로그 전환·사후 작성 모드 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 프로젝트의 행만 셉니다(개발 DB에 남은 행과 무관).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { OPEN_TASK_LIMIT } from '@peerchive/domain'
import { auditEvents, eq, logEntries, tasks, type DbExecutor } from '@peerchive/db'
import { createLog, getLog, listLogs } from '../server/modules/logs/logs'
import { addSnapshot, applyMilestoneTemplate, createMilestone, listMilestones } from '../server/modules/milestones/milestones'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { removeMember } from '../server/modules/projects/members'
import { createProject, getProject, updateProject } from '../server/modules/projects/projects'
import {
  completeTask,
  convertTask,
  createTask,
  deleteTask,
  listTasks,
  reorderTasks,
  updateTask,
} from '../server/modules/tasks/tasks'
import { artifactVersions, artifacts } from '@peerchive/db'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))

async function teamWith(db: DbExecutor, roles: Array<'editor' | 'reviewer' | 'viewer'>, options: { retroMode?: boolean } = {}) {
  const owner = await createUser(db, { displayName: '소유자' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team', ...options })
  const members = []
  for (const role of roles) {
    const user = await createUser(db, { displayName: role })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members.push(user)
  }
  return { owner, project, members }
}

const titles = (list: Array<{ title: string }>) => list.map((t) => t.title)
const stuckPayload = { symptom: '배포 후 이미지가 깨짐', timeBucket: 'lt2h' }

describe.skipIf(!databaseUrl)('tasks, completion → log conversion and retro mode (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('owner/editor manage tasks; reviewer/viewer read but get FORBIDDEN; non-members NOT_FOUND', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, ['editor', 'reviewer', 'viewer'])
      const [editor, reviewer, viewer] = members
      const stranger = await createUser(tx)

      const first = await createTask(tx, { userId: owner.id }, project.id, { title: ' 와이어프레임 ', dueAt: '2026-11-10' }, T0)
      expect(first).toMatchObject({
        projectId: project.id,
        title: '와이어프레임',
        note: null,
        status: 'todo',
        position: 1,
        assignee: null,
        dueAt: '2026-11-10',
        completedAt: null,
        log: null,
        version: 1,
        createdBy: owner.id,
      })
      const second = await createTask(tx, { userId: editor!.id }, project.id, { title: 'API 설계', status: 'doing', assigneeId: editor!.id }, T0)
      expect(second).toMatchObject({ status: 'doing', position: 1, assignee: { userId: editor!.id, displayName: 'editor' } })

      for (const reader of [reviewer!, viewer!]) {
        const actor = { userId: reader.id }
        expect(titles(await listTasks(tx, actor, project.id, {}))).toEqual(['와이어프레임', 'API 설계'])
        await expectServiceError(createTask(tx, actor, project.id, { title: 'x' }), 'FORBIDDEN')
        await expectServiceError(updateTask(tx, actor, first.id, { expectedVersion: 1, title: 'x' }), 'FORBIDDEN')
        await expectServiceError(reorderTasks(tx, actor, project.id, { status: 'todo', taskIds: [first.id] }), 'FORBIDDEN')
        await expectServiceError(completeTask(tx, actor, first.id, { expectedVersion: 1 }), 'FORBIDDEN')
        await expectServiceError(convertTask(tx, actor, first.id, { tag: 'progress', body: 'x' }), 'FORBIDDEN')
        await expectServiceError(deleteTask(tx, actor, first.id), 'FORBIDDEN')
      }

      const outsider = { userId: stranger.id }
      await expectServiceError(listTasks(tx, outsider, project.id, {}), 'NOT_FOUND')
      await expectServiceError(createTask(tx, outsider, project.id, { title: 'x' }), 'NOT_FOUND')
      await expectServiceError(updateTask(tx, outsider, first.id, { expectedVersion: 1, title: 'x' }), 'NOT_FOUND')
      await expectServiceError(completeTask(tx, outsider, first.id, { expectedVersion: 1 }), 'NOT_FOUND')
      await expectServiceError(convertTask(tx, outsider, first.id, { tag: 'progress', body: 'x' }), 'NOT_FOUND')
      await expectServiceError(deleteTask(tx, outsider, first.id), 'NOT_FOUND')
      await expectServiceError(deleteTask(tx, { userId: owner.id }, crypto.randomUUID()), 'NOT_FOUND')
      await expectServiceError(listTasks(tx, { userId: owner.id }, 'not-a-uuid', {}), 'NOT_FOUND')

      // status 필터
      expect(titles(await listTasks(tx, { userId: owner.id }, project.id, { status: 'doing' }))).toEqual(['API 설계'])
      const badQuery = await expectServiceError(listTasks(tx, { userId: owner.id }, project.id, { status: 'archived' }), 'VALIDATION')
      expect(badQuery.fields).toEqual({ status: 'invalid' })
    })
  })

  it('validates input and requires the assignee to be an active member', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, ['editor', 'viewer'])
      const [editor, viewer] = members
      const actor = { userId: owner.id }
      const stranger = await createUser(tx)
      const fieldsOf = async (input: unknown) =>
        (await expectServiceError(createTask(tx, actor, project.id, input, T0), 'VALIDATION')).fields

      expect(await fieldsOf({})).toEqual({ title: 'required' })
      expect(await fieldsOf({ title: '가'.repeat(121) })).toEqual({ title: 'too_long' })
      expect(await fieldsOf({ title: 'x', note: '가'.repeat(1001) })).toEqual({ note: 'too_long' })
      expect(await fieldsOf({ title: 'x', dueAt: '2026-02-30' })).toEqual({ dueAt: 'invalid_format' })
      expect(await fieldsOf({ title: 'x', status: 'done' })).toEqual({ status: 'invalid' })
      expect(await fieldsOf({ title: 'x', assigneeId: 'nope' })).toEqual({ assigneeId: 'invalid' })
      expect(await fieldsOf({ title: 'x', assigneeId: stranger.id })).toEqual({ assigneeId: 'not_member' })

      // 읽기 전용 멤버도 담당자가 될 수 있습니다(역할 무관, active만).
      const task = await createTask(tx, actor, project.id, { title: '자료 조사', assigneeId: viewer!.id }, T0)
      expect(task.assignee?.userId).toBe(viewer!.id)

      // 나간 멤버는 새로 지정할 수 없지만, 이미 지정된 할 일의 다른 필드는 고칠 수 있습니다.
      const assigned = await createTask(tx, actor, project.id, { title: '배포', assigneeId: editor!.id }, T0)
      await removeMember(tx, actor, project.id, editor!.id)
      const renamed = await updateTask(tx, actor, assigned.id, { expectedVersion: 1, title: '배포 준비' }, at(1))
      expect(renamed).toMatchObject({ title: '배포 준비', version: 2, assignee: { userId: editor!.id } })
      const reassign = await expectServiceError(
        updateTask(tx, actor, task.id, { expectedVersion: 1, assigneeId: editor!.id }),
        'VALIDATION',
      )
      expect(reassign.fields).toEqual({ assigneeId: 'not_member' })
      const cleared = await updateTask(tx, actor, task.id, { expectedVersion: 1, assigneeId: null, note: '도서관 DB' }, at(2))
      expect(cleared).toMatchObject({ assignee: null, note: '도서관 DB', version: 2 })
    })
  })

  it('keeps positions contiguous per status, reorders only full permutations, and moves to the end on status change', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx, [])
      const actor = { userId: owner.id }
      const [a, b, c] = [
        await createTask(tx, actor, project.id, { title: 'A' }, T0),
        await createTask(tx, actor, project.id, { title: 'B' }, T0),
        await createTask(tx, actor, project.id, { title: 'C' }, T0),
      ]
      const d = await createTask(tx, actor, project.id, { title: 'D', status: 'doing' }, T0)
      expect([a, b, c, d].map((t) => t!.position)).toEqual([1, 2, 3, 1])

      const reordered = await reorderTasks(tx, actor, project.id, { status: 'todo', taskIds: [c!.id, a!.id, b!.id] })
      expect(reordered.map((t) => `${t.status}:${t.position}:${t.title}`)).toEqual([
        'todo:1:C',
        'todo:2:A',
        'todo:3:B',
        'doing:1:D',
      ])
      // 순서 변경은 version을 올리지 않습니다.
      expect(reordered.find((t) => t.id === a!.id)?.version).toBe(1)

      const reorder = (status: string, taskIds: string[]) => reorderTasks(tx, actor, project.id, { status, taskIds })
      expect((await expectServiceError(reorder('todo', [a!.id, a!.id, b!.id]), 'VALIDATION')).fields).toEqual({ taskIds: 'duplicate' })
      expect((await expectServiceError(reorder('todo', [a!.id, b!.id]), 'VALIDATION')).fields).toEqual({ taskIds: 'mismatch' })
      // 다른 상태의 할 일은 모르는 id로 봅니다.
      expect((await expectServiceError(reorder('todo', [a!.id, b!.id, d!.id]), 'VALIDATION')).fields).toEqual({ taskIds: 'mismatch' })
      expect((await expectServiceError(reorder('later', []), 'VALIDATION')).fields).toEqual({ status: 'invalid' })

      // A(todo 2번째)를 진행 중으로 → doing 맨 뒤, todo는 당겨짐.
      const moved = await updateTask(tx, actor, a!.id, { expectedVersion: 1, status: 'doing' }, at(1))
      expect(moved).toMatchObject({ status: 'doing', position: 2, version: 2, completedAt: null })
      const list = await listTasks(tx, actor, project.id, {})
      expect(list.map((t) => `${t.status}:${t.position}:${t.title}`)).toEqual(['todo:1:C', 'todo:2:B', 'doing:1:D', 'doing:2:A'])

      // 낡은 version은 409 + currentVersion
      const stale = await expectServiceError(updateTask(tx, actor, a!.id, { expectedVersion: 1, title: 'A2' }), 'CONFLICT', 'version_conflict')
      expect(stale.details).toEqual({ currentVersion: 2 })
      await expectServiceError(completeTask(tx, actor, a!.id, { expectedVersion: 1 }), 'CONFLICT', 'version_conflict')

      // PATCH로 완료하면 완료 정보가 채워지고, 되돌리면 비워집니다.
      const done = await updateTask(tx, actor, c!.id, { expectedVersion: 1, status: 'done' }, at(2))
      expect(done).toMatchObject({ status: 'done', position: 1, completedBy: owner.id, completedAt: at(2).toISOString() })
      const reopened = await updateTask(tx, actor, c!.id, { expectedVersion: 2, status: 'todo' }, at(3))
      expect(reopened).toMatchObject({ status: 'todo', position: 2, completedAt: null, completedBy: null })
      expect((await listTasks(tx, actor, project.id, { status: 'todo' })).map((t) => t.title)).toEqual(['B', 'C'])
    })
  })

  it('board (E-09): cross-column moves place the task at a position in one request, with the same permissions and validation', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, ['editor', 'viewer'])
      const [editor, viewer] = members
      const actor = { userId: editor!.id }
      const [a, b, c] = [
        await createTask(tx, actor, project.id, { title: 'A' }, T0),
        await createTask(tx, actor, project.id, { title: 'B' }, T0),
        await createTask(tx, actor, project.id, { title: 'C' }, T0),
      ]
      const d = await createTask(tx, actor, project.id, { title: 'D', status: 'doing' }, T0)
      const e = await createTask(tx, actor, project.id, { title: 'E', status: 'doing' }, T0)
      const board = async () => (await listTasks(tx, actor, project.id, {})).map((t) => `${t.status}:${t.position}:${t.title}`)

      // B를 진행 중 1번째(D 앞)로: 원래 열은 당기고 새 열은 그 자리에 끼웁니다.
      const moved = await updateTask(tx, actor, b!.id, { expectedVersion: 1, status: 'doing', position: 1 }, at(1))
      expect(moved).toMatchObject({ status: 'doing', position: 1, version: 2 })
      expect(await board()).toEqual(['todo:1:A', 'todo:2:C', 'doing:1:B', 'doing:2:D', 'doing:3:E'])

      // 가운데 자리, 그리고 목록 길이 + 1을 넘는 자리는 맨 뒤.
      await updateTask(tx, actor, c!.id, { expectedVersion: 1, status: 'doing', position: 3 }, at(2))
      expect(await board()).toEqual(['todo:1:A', 'doing:1:B', 'doing:2:D', 'doing:3:C', 'doing:4:E'])
      await updateTask(tx, actor, d!.id, { expectedVersion: 1, status: 'todo', position: 99 }, at(3))
      expect(await board()).toEqual(['todo:1:A', 'todo:2:D', 'doing:1:B', 'doing:2:C', 'doing:3:E'])

      // 완료로 옮기기(/complete + position): 프롬프트는 리스트와 같고, 완료 목록의 그 자리에 놓입니다.
      const first = await completeTask(tx, actor, e!.id, { expectedVersion: 1, position: 1 }, at(4))
      expect(first.prompt).toEqual({ askStuck: true, askDecision: true })
      const second = await completeTask(tx, actor, a!.id, { expectedVersion: 1, position: 1 }, at(5))
      expect(second.task).toMatchObject({ status: 'done', position: 1, completedBy: editor!.id })
      expect(await board()).toEqual(['todo:1:D', 'doing:1:B', 'doing:2:C', 'done:1:A', 'done:2:E'])
      // 이미 완료한 할 일의 재전송은 자리도 바꾸지 않습니다.
      const again = await completeTask(tx, actor, e!.id, { expectedVersion: 1, position: 1 }, at(6))
      expect(again.task).toMatchObject({ position: 2, version: 2 })

      // 완료에서 되돌리며 자리 지정(완료 정보 비움).
      const reopened = await updateTask(tx, actor, a!.id, { expectedVersion: 2, status: 'doing', position: 2 }, at(7))
      expect(reopened).toMatchObject({ status: 'doing', position: 2, completedAt: null, completedBy: null })
      expect(await board()).toEqual(['todo:1:D', 'doing:1:B', 'doing:2:A', 'doing:3:C', 'done:1:E'])

      // 검증: 상태가 바뀌지 않는 position은 422(같은 열 안은 순서 변경 API), 잘못된 값 422, 낡은 version 409.
      const fields = async (input: Record<string, unknown>) => (await expectServiceError(updateTask(tx, actor, b!.id, input), 'VALIDATION')).fields
      expect(await fields({ expectedVersion: 2, position: 1 })).toEqual({ position: 'status_required' })
      expect(await fields({ expectedVersion: 2, status: 'doing', position: 1 })).toEqual({ position: 'status_required' })
      expect(await fields({ expectedVersion: 2, status: 'todo', position: 0 })).toEqual({ position: 'invalid' })
      expect(await fields({ expectedVersion: 2, status: 'todo', position: 1.5 })).toEqual({ position: 'invalid' })
      expect(await fields({ expectedVersion: 2, status: 'todo', position: '1' })).toEqual({ position: 'invalid' })
      expect((await expectServiceError(completeTask(tx, actor, b!.id, { expectedVersion: 2, position: -1 }), 'VALIDATION')).fields).toEqual({ position: 'invalid' })
      await expectServiceError(updateTask(tx, actor, b!.id, { expectedVersion: 1, status: 'todo', position: 1 }), 'CONFLICT', 'version_conflict')

      // 권한: 리스트와 같습니다(viewer 403, 비멤버 404). 아무것도 바뀌지 않습니다.
      await expectServiceError(updateTask(tx, { userId: viewer!.id }, b!.id, { expectedVersion: 2, status: 'todo', position: 1 }), 'FORBIDDEN')
      await expectServiceError(completeTask(tx, { userId: viewer!.id }, b!.id, { expectedVersion: 2, position: 1 }), 'FORBIDDEN')
      const outsider = await createUser(tx, { displayName: '외부인' })
      await expectServiceError(updateTask(tx, { userId: outsider.id }, b!.id, { expectedVersion: 2, status: 'todo', position: 1 }), 'NOT_FOUND')
      expect(await board()).toEqual(['todo:1:D', 'doing:1:B', 'doing:2:A', 'doing:3:C', 'done:1:E'])

      // 같은 열 안 이동은 기존 순서 변경(전체 순열)을 그대로 씁니다. owner도 같은 규칙.
      const reordered = await reorderTasks(tx, { userId: owner.id }, project.id, { status: 'doing', taskIds: [c!.id, b!.id, a!.id] })
      expect(reordered.map((t) => `${t.status}:${t.position}:${t.title}`)).toEqual(['todo:1:D', 'doing:1:C', 'doing:2:B', 'doing:3:A', 'done:1:E'])
    })
  })

  it('completes with a prompt; completing without converting is fine; delete is allowed only for unconverted tasks', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, ['editor'])
      const [editor] = members
      const actor = { userId: editor!.id }
      const task = await createTask(tx, actor, project.id, { title: '발표 자료' }, T0)
      const other = await createTask(tx, actor, project.id, { title: '리허설' }, T0)

      const completed = await completeTask(tx, actor, task.id, { expectedVersion: 1 }, at(5))
      expect(completed.prompt).toEqual({ askStuck: true, askDecision: true })
      expect(completed.task).toMatchObject({ status: 'done', position: 1, version: 2, completedBy: editor!.id, log: null })
      // 재전송은 바꾸지 않고 같은 결과를 돌려줍니다(version이 낡아도).
      const again = await completeTask(tx, actor, task.id, { expectedVersion: 1 }, at(6))
      expect(again.task).toMatchObject({ version: 2, completedAt: at(5).toISOString() })
      expect((await expectServiceError(completeTask(tx, actor, other.id, {}), 'VALIDATION')).fields).toEqual({ expectedVersion: 'required' })
      // 남은 todo는 당겨졌습니다.
      expect((await listTasks(tx, actor, project.id, { status: 'todo' })).map((t) => [t.title, t.position])).toEqual([['리허설', 1]])

      // 로그로 남기지 않아도 완료는 끝났고, 로그는 하나도 생기지 않았습니다.
      const logs = await tx.select().from(logEntries).where(eq(logEntries.projectId, project.id))
      expect(logs).toEqual([])

      // 전환하지 않은 할 일은 지울 수 있습니다(완료 여부 무관).
      await deleteTask(tx, actor, task.id)
      await deleteTask(tx, { userId: owner.id }, other.id)
      expect(await listTasks(tx, actor, project.id, {})).toEqual([])
      await expectServiceError(deleteTask(tx, actor, task.id), 'NOT_FOUND')

      const actions = (await tx.select().from(auditEvents).where(eq(auditEvents.projectId, project.id))).map((e) => e.action)
      expect(actions).toEqual(expect.arrayContaining(['task.create', 'task.complete', 'task.delete']))
    })
  })

  it('converts a completed task into a build log once (source task), reusing build log validation', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx, [])
      const actor = { userId: owner.id }
      const task = await createTask(tx, actor, project.id, { title: '이미지 최적화' }, T0)

      // 완료 전에는 전환할 수 없습니다.
      await expectServiceError(convertTask(tx, actor, task.id, { tag: 'stuck', payload: stuckPayload }), 'CONFLICT', 'not_done')
      await completeTask(tx, actor, task.id, { expectedVersion: 1 }, at(1))

      // 빌드 로그 규칙 그대로 422(모르는 키·필수 필드), 그리고 전환할 수 없는 태그.
      const bad = await expectServiceError(
        convertTask(tx, actor, task.id, { tag: 'stuck', payload: { symptom: '', extra: 1 } }),
        'VALIDATION',
      )
      expect(bad.fields).toEqual({ payload: 'unknown_key', 'payload.symptom': 'required', 'payload.timeBucket': 'required' })
      const decisionBad = await expectServiceError(
        convertTask(tx, actor, task.id, { tag: 'decision', payload: { options: ['WebP'], criteria: '용량', choice: 'WebP' } }),
        'VALIDATION',
      )
      expect(decisionBad.fields).toEqual({ 'payload.options': 'too_few' })
      expect((await expectServiceError(convertTask(tx, actor, task.id, { tag: 'solution' }), 'VALIDATION')).fields).toEqual({ tag: 'invalid' })
      expect((await expectServiceError(convertTask(tx, actor, task.id, {}), 'VALIDATION')).fields).toEqual({ tag: 'required' })
      // 실패한 시도는 아무것도 남기지 않았습니다.
      expect(await tx.select().from(logEntries).where(eq(logEntries.projectId, project.id))).toEqual([])

      const { task: converted, log } = await convertTask(
        tx,
        actor,
        task.id,
        { tag: 'stuck', body: '이미지 최적화', payload: stuckPayload, clientId: crypto.randomUUID() },
        at(2),
      )
      expect(log).toMatchObject({
        tag: 'stuck',
        source: 'task',
        retrospective: false,
        body: '이미지 최적화',
        task: { id: task.id, title: '이미지 최적화' },
      })
      expect(converted).toMatchObject({ log: { id: log.id, tag: 'stuck' }, version: 3 })
      // 로그 조회에서도 출처 할 일이 보입니다.
      expect((await getLog(tx, actor, log.id)).task).toEqual({ id: task.id, title: '이미지 최적화' })

      // 두 번째 전환은 409, 되돌렸다 다시 완료해도 마찬가지.
      await expectServiceError(convertTask(tx, actor, task.id, { tag: 'progress', body: '다시' }), 'CONFLICT', 'already_converted')
      const reopened = await updateTask(tx, actor, task.id, { expectedVersion: 3, status: 'todo' }, at(3))
      expect(reopened.log).toEqual({ id: log.id, tag: 'stuck' })
      const recompleted = await completeTask(tx, actor, task.id, { expectedVersion: 4 }, at(4))
      expect(recompleted.prompt).toBeNull()
      await expectServiceError(convertTask(tx, actor, task.id, { tag: 'progress', body: '다시' }), 'CONFLICT', 'already_converted')

      // 전환한 할 일은 지울 수 없습니다.
      await expectServiceError(deleteTask(tx, actor, task.id), 'CONFLICT', 'converted')

      const rows = await tx.select().from(logEntries).where(eq(logEntries.projectId, project.id))
      expect(rows).toHaveLength(1)
      const [link] = await tx.select({ logEntryId: tasks.logEntryId }).from(tasks).where(eq(tasks.id, task.id))
      expect(link?.logEntryId).toBe(log.id)
    })
  })

  it('enforces the open task limit, including when reopening', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx, [])
      const actor = { userId: owner.id }
      const done = await createTask(tx, actor, project.id, { title: 'done' }, T0)
      await completeTask(tx, actor, done.id, { expectedVersion: 1 }, T0)
      await tx.insert(tasks).values(
        Array.from({ length: OPEN_TASK_LIMIT }, (_, i) => ({
          projectId: project.id,
          title: `t${i}`,
          position: i + 1,
          createdBy: owner.id,
        })),
      )
      const full = await expectServiceError(createTask(tx, actor, project.id, { title: 'x' }), 'CONFLICT', 'limit_reached')
      expect(full.details).toEqual({ limit: OPEN_TASK_LIMIT })
      await expectServiceError(updateTask(tx, actor, done.id, { expectedVersion: 2, status: 'todo' }), 'CONFLICT', 'limit_reached')
    })
  })

  it('retro mode: logs, milestones and snapshots created in it are marked retrospective; others are not', async () => {
    await withRollback(async (tx) => {
      const retro = await teamWith(tx, ['editor'], { retroMode: true })
      const live = await teamWith(tx, [])
      expect(retro.project).toMatchObject({ retroMode: true, retrospective: true })
      expect(live.project).toMatchObject({ retroMode: false, retrospective: false })

      const owner = { userId: retro.owner.id }
      const { log } = await createLog(tx, owner, retro.project.id, { tag: 'progress', body: '기획서 정리', claimedDate: '2025-03-10' }, T0)
      expect(log).toMatchObject({ source: 'retro', retrospective: true, claimedDate: '2025-03-10' })
      const { log: liveLog } = await createLog(tx, { userId: live.owner.id }, live.project.id, { tag: 'progress', body: '오늘 한 일' }, T0)
      expect(liveLog).toMatchObject({ source: 'web', retrospective: false })

      // 사후 작성 과제에서 할 일을 전환한 로그: 출처는 task, 표시는 사후 작성.
      const task = await createTask(tx, owner, retro.project.id, { title: 'DB 선택' }, T0)
      await completeTask(tx, owner, task.id, { expectedVersion: 1 }, T0)
      const { log: taskLog } = await convertTask(
        tx,
        owner,
        task.id,
        { tag: 'decision', body: 'DB 선택', payload: { options: ['MySQL', 'Firebase'], criteria: '팀 경험', choice: 'MySQL' } },
        at(1),
      )
      expect(taskLog).toMatchObject({ source: 'task', retrospective: true })

      const milestone = await createMilestone(tx, owner, retro.project.id, { title: '중간발표', claimedAt: '2025-04-20' }, T0)
      expect(milestone.retrospective).toBe(true)
      const [liveTemplate] = await applyMilestoneTemplate(tx, { userId: live.owner.id }, live.project.id, T0)
      expect(liveTemplate?.retrospective).toBe(false)

      const [artifact] = await tx.insert(artifacts).values({ projectId: retro.project.id, uploaderId: retro.owner.id, title: '발표.pdf' }).returning()
      const [version] = await tx
        .insert(artifactVersions)
        .values({
          artifactId: artifact!.id,
          versionNo: 1,
          uploaderId: retro.owner.id,
          fileName: '발표.pdf',
          declaredType: 'application/pdf',
          mediaType: 'application/pdf',
          bytes: 10,
          sha256: 'a'.repeat(64),
          objectKey: `clean/${crypto.randomUUID()}`,
          scanStatus: 'clean',
        })
        .returning()
      const withSnapshot = await addSnapshot(tx, owner, milestone.id, { artifactVersionId: version!.id }, T0)
      expect(withSnapshot.snapshots[0]?.retrospective).toBe(true)

      // 모드를 꺼도 이미 만든 항목의 표시는 남고, 이후 항목만 진행 중 기록이 됩니다.
      const off = await updateProject(tx, owner, retro.project.id, { expectedVersion: retro.project.version, retroMode: false })
      expect(off).toMatchObject({ retroMode: false, retrospective: false })
      const { log: afterOff } = await createLog(tx, owner, retro.project.id, { tag: 'progress', body: '이제부터 진행 중 기록' }, at(2))
      expect(afterOff).toMatchObject({ source: 'web', retrospective: false })
      const page = await listLogs(tx, owner, retro.project.id, {})
      expect(page.items.map((l) => [l.body, l.retrospective])).toEqual([
        ['이제부터 진행 중 기록', false],
        ['DB 선택', true],
        ['기획서 정리', true],
      ])
      const [kept] = await listMilestones(tx, owner, retro.project.id)
      expect(kept).toMatchObject({ retrospective: true, snapshots: [expect.objectContaining({ retrospective: true })] })
    })
  })

  it('only the owner changes retro mode (both directions); editors may still edit other fields', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, ['editor', 'viewer'])
      const [editor, viewer] = members

      await expectServiceError(
        updateProject(tx, { userId: editor!.id }, project.id, { expectedVersion: 1, retroMode: true }),
        'FORBIDDEN',
      )
      await expectServiceError(
        updateProject(tx, { userId: viewer!.id }, project.id, { expectedVersion: 1, retroMode: true }),
        'FORBIDDEN',
      )
      // 같은 값을 보내는 것은 바꾸는 것이 아니므로 editor도 됩니다.
      const edited = await updateProject(tx, { userId: editor!.id }, project.id, { expectedVersion: 1, goal: '목표', retroMode: false })
      expect(edited).toMatchObject({ goal: '목표', retroMode: false, version: 2 })
      const validation = await expectServiceError(
        updateProject(tx, { userId: owner.id }, project.id, { expectedVersion: 2, retroMode: 'yes' }),
        'VALIDATION',
      )
      expect(validation.fields).toEqual({ retroMode: 'invalid' })

      const on = await updateProject(tx, { userId: owner.id }, project.id, { expectedVersion: 2, retroMode: true })
      expect(on).toMatchObject({ retroMode: true, retrospective: true, version: 3 })
      const offAgain = await updateProject(tx, { userId: owner.id }, project.id, { expectedVersion: 3, retroMode: false })
      expect(offAgain.retroMode).toBe(false)
      expect((await getProject(tx, { userId: viewer!.id }, project.id)).retrospective).toBe(false)

      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.projectId, project.id))
      expect(audits.filter((a) => a.action === 'project.retro_mode').map((a) => a.metadata)).toEqual([
        { retroMode: true },
        { retroMode: false },
      ])
    })
  })
})
