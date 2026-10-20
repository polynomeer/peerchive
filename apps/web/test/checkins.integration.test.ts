/**
 * T-09 주간 체크인 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 프로젝트의 행만 셉니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { eq, logEntries, weeklyCheckins, type DbExecutor } from '@peerchive/db'
import {
  getMyCheckin,
  listCheckins,
  myCheckinStatus,
  saveMyCheckin,
} from '../server/modules/checkins/checkins'
import { getLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

/** 2026-10-20(화) 12:00 KST → 2026-W43(10-19 ~ 10-25). */
const T0 = new Date('2026-10-20T03:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))

async function team(db: DbExecutor) {
  const owner = await createUser(db, { displayName: '가나다' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' })
  const users = []
  for (const [role, name] of [
    ['editor', '라마바'],
    ['viewer', '사아자'],
  ] as const) {
    const user = await createUser(db, { displayName: name })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    users.push(user)
  }
  return { owner, project, editor: users[0]!, viewer: users[1]! }
}

const rowsOf = (db: DbExecutor, projectId: string) =>
  db.select().from(weeklyCheckins).where(eq(weeklyCheckins.projectId, projectId))

describe.skipIf(!databaseUrl)('weekly check-ins (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('one check-in per member and week; submitting again updates it', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx)
      const actor = { userId: owner.id }
      expect(await getMyCheckin(tx, actor, project.id, {}, T0)).toEqual({
        week: '2026-W43',
        from: '2026-10-19',
        to: '2026-10-25',
        checkin: null,
      })

      const first = await saveMyCheckin(tx, actor, project.id, { timeBucket: 'lt5h', difficulty: 3, note: ' 로그인 API 완성 ' }, T0)
      expect(first.created).toBe(true)
      expect(first.log).toBeNull()
      expect(first.checkin).toMatchObject({
        week: '2026-W43',
        timeBucket: 'lt5h',
        difficulty: 3,
        note: '로그인 API 완성',
        shareForStats: false,
        skipReasons: [],
        promotedLogId: null,
      })

      const second = await saveMyCheckin(
        tx,
        actor,
        project.id,
        { week: '2026-W43', timeBucket: 'lt10h', difficulty: 4, note: '', shareForStats: true, skipReasons: ['busy', 'busy', 'other'] },
        at(10),
      )
      expect(second.created).toBe(false)
      expect(second.checkin).toMatchObject({ id: first.checkin.id, timeBucket: 'lt10h', note: null, shareForStats: true, skipReasons: ['busy', 'other'] })
      expect(second.checkin.updatedAt).toBe(at(10).toISOString())
      expect(await rowsOf(tx, project.id)).toHaveLength(1)

      // 지난주는 낼 수 있고, 그 전이나 다음 주는 안 됩니다.
      expect((await saveMyCheckin(tx, actor, project.id, { week: '2026-W42', timeBucket: 'none', difficulty: 1 }, T0)).created).toBe(true)
      await expectServiceError(
        saveMyCheckin(tx, actor, project.id, { week: '2026-W41', timeBucket: 'none', difficulty: 1 }, T0),
        'VALIDATION',
      ).then((e) => expect(e.fields).toEqual({ week: 'out_of_range' }))
      await expectServiceError(
        saveMyCheckin(tx, actor, project.id, { week: '2026-W44', timeBucket: 'none', difficulty: 1 }, T0),
        'VALIDATION',
      )
      await expectServiceError(
        saveMyCheckin(tx, actor, project.id, { timeBucket: 'forever', difficulty: 6, note: 'x'.repeat(201) }, T0),
        'VALIDATION',
      ).then((e) => expect(e.fields).toEqual({ timeBucket: 'required', difficulty: 'invalid', note: 'too_long' }))
      expect(await rowsOf(tx, project.id)).toHaveLength(2)

      const stranger = await createUser(tx)
      await expectServiceError(saveMyCheckin(tx, { userId: stranger.id }, project.id, { timeBucket: 'none', difficulty: 1 }, T0), 'NOT_FOUND')
      await expectServiceError(listCheckins(tx, { userId: stranger.id }, project.id, {}, T0), 'NOT_FOUND')
    })
  })

  it('promotes the note to a build log once (progress or stuck), through the build-log rules', async () => {
    await withRollback(async (tx) => {
      const { owner, project, editor, viewer } = await team(tx)
      const saved = await saveMyCheckin(
        tx,
        { userId: editor.id },
        project.id,
        { timeBucket: 'lt10h', difficulty: 5, note: '배포 후 이미지가 깨짐', promote: { tag: 'stuck' } },
        T0,
      )
      expect(saved.log).toMatchObject({
        tag: 'stuck',
        source: 'web',
        author: { userId: editor.id },
        payload: { symptom: '배포 후 이미지가 깨짐', timeBucket: 'day_plus' },
      })
      expect(saved.checkin.promotedLogId).toBe(saved.log!.id)

      // 다시 내고 다시 옮기기를 눌러도 로그는 하나입니다.
      const again = await saveMyCheckin(
        tx,
        { userId: editor.id },
        project.id,
        { timeBucket: 'lt10h', difficulty: 4, note: '배포 후 이미지가 깨짐(수정)', promote: { tag: 'progress' } },
        at(5),
      )
      expect(again.log!.id).toBe(saved.log!.id)
      expect(await tx.select().from(logEntries).where(eq(logEntries.projectId, project.id))).toHaveLength(1)

      const progress = await saveMyCheckin(
        tx,
        { userId: owner.id },
        project.id,
        { timeBucket: 'lt2h', difficulty: 2, note: '와이어프레임 완성', promote: { tag: 'progress' } },
        T0,
      )
      expect(await getLog(tx, { userId: owner.id }, progress.log!.id)).toMatchObject({ tag: 'progress', body: '와이어프레임 완성' })

      await expectServiceError(
        saveMyCheckin(tx, { userId: owner.id }, project.id, { timeBucket: 'lt2h', difficulty: 2, promote: { tag: 'progress' } }, T0),
        'VALIDATION',
      ).then((e) => expect(e.fields).toEqual({ note: 'required' }))
      // viewer는 체크인은 내지만 로그로 옮길 수는 없습니다(체크인도 함께 취소).
      await expectServiceError(
        saveMyCheckin(tx, { userId: viewer.id }, project.id, { timeBucket: 'none', difficulty: 1, note: '읽기만 함', promote: { tag: 'progress' } }, T0),
        'FORBIDDEN',
      )
      expect((await saveMyCheckin(tx, { userId: viewer.id }, project.id, { timeBucket: 'none', difficulty: 1, note: '읽기만 함' }, T0)).created).toBe(true)
    })
  })

  it("team members see who submitted and each other's answers, but stats consent and skip reasons stay private", async () => {
    await withRollback(async (tx) => {
      const { owner, project, editor, viewer } = await team(tx)
      await saveMyCheckin(
        tx,
        { userId: editor.id },
        project.id,
        { timeBucket: 'lt5h', difficulty: 4, note: '막힘 해결', shareForStats: true, skipReasons: ['bothersome'] },
        T0,
      )
      const week = await listCheckins(tx, { userId: viewer.id }, project.id, {}, T0)
      expect(week).toMatchObject({ week: '2026-W43', from: '2026-10-19', to: '2026-10-25' })
      expect(week.entries.map((e) => [e.member.displayName, e.submitted])).toEqual([
        ['가나다', false],
        ['라마바', true],
        ['사아자', false],
      ])
      expect(week.entries[1]).toMatchObject({ timeBucket: 'lt5h', difficulty: 4, note: '막힘 해결' })
      const json = JSON.stringify(week)
      expect(json).not.toContain('shareForStats')
      expect(json).not.toContain('bothersome')
      expect(json).not.toContain('@')

      expect((await listCheckins(tx, { userId: owner.id }, project.id, { week: '2026-W42' }, T0)).entries.every((e) => !e.submitted)).toBe(true)
      await expectServiceError(listCheckins(tx, { userId: owner.id }, project.id, { week: '2026-W99' }, T0), 'VALIDATION')

      const status = await myCheckinStatus(tx, { userId: editor.id }, T0)
      expect(status.week).toBe('2026-W43')
      expect(status.projects).toContainEqual({ projectId: project.id, title: '캡스톤 디자인', submitted: true })
      expect((await myCheckinStatus(tx, { userId: owner.id }, T0)).projects).toContainEqual({
        projectId: project.id,
        title: '캡스톤 디자인',
        submitted: false,
      })
    })
  })
})
