/**
 * T-03 서비스 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { auditEvents, eq, invitations, projectMembers, projects, type DbExecutor } from '@peerchive/db'
import {
  INVITATION_TTL_MS,
  acceptInvitation,
  createInvitation,
  listInvitations,
  revokeInvitation,
} from '../server/modules/projects/invitations'
import {
  changeMemberRole,
  leaveProject,
  listMembers,
  removeMember,
  transferOwnership,
} from '../server/modules/projects/members'
import { createProject, getProject, listMyProjects, updateProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')

function firstTwo<T>(items: T[]): [T, T] {
  const [a, b] = items
  if (!a || !b) throw new Error('expected two items')
  return [a, b]
}

/** owner가 만든 팀 프로젝트에 role로 초대·수락된 멤버를 붙입니다. */
async function teamWith(db: DbExecutor, ...roles: Array<'editor' | 'reviewer' | 'viewer'>) {
  const owner = await createUser(db)
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' })
  const members = []
  for (const role of roles) {
    const user = await createUser(db)
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members.push(user)
  }
  return { owner, project, members }
}

describe.skipIf(!databaseUrl)('project services (PostgreSQL)', () => {
  afterAll(closeTestDb)

  describe('projects', () => {
    it('creator becomes the active owner; project is private by default', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx)
        const project = await createProject(tx, { userId: user.id }, { title: '  자료구조 과제 ' })
        expect(project).toMatchObject({ title: '자료구조 과제', kind: 'individual', visibility: 'private', version: 1, myRole: 'owner' })
        const [row] = await tx.select().from(projects).where(eq(projects.id, project.id))
        expect(row?.ownerId).toBe(user.id)
        const members = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, project.id))
        expect(members).toEqual([expect.objectContaining({ userId: user.id, role: 'owner', status: 'active' })])
        expect((await listMyProjects(tx, { userId: user.id })).map((p) => p.id)).toContain(project.id)
        const audits = await tx.select().from(auditEvents).where(eq(auditEvents.projectId, project.id))
        expect(audits.map((a) => a.action)).toEqual(['project.create'])
      })
    })

    it('validates input and requires an existing course term', async () => {
      await withRollback(async (tx) => {
        const user = await createUser(tx)
        const bad = await expectServiceError(createProject(tx, { userId: user.id }, { title: '', kind: 'club' }), 'VALIDATION')
        expect(bad.fields).toMatchObject({ title: 'required', kind: 'invalid' })
        const term = await expectServiceError(
          createProject(tx, { userId: user.id }, { title: 'x', courseTermId: crypto.randomUUID() }),
          'VALIDATION',
        )
        expect(term.fields).toEqual({ courseTermId: 'not_found' })
      })
    })

    it('non-members, removed members and admins get NOT_FOUND, same as a missing project', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'viewer')
        const stranger = await createUser(tx)
        await expectServiceError(getProject(tx, { userId: stranger.id }, project.id), 'NOT_FOUND')
        await expectServiceError(getProject(tx, { userId: stranger.id }, crypto.randomUUID()), 'NOT_FOUND')
        await expectServiceError(getProject(tx, { userId: stranger.id }, 'not-a-uuid'), 'NOT_FOUND')
        await expectServiceError(listMembers(tx, { userId: stranger.id }, project.id), 'NOT_FOUND')
        expect(await listMyProjects(tx, { userId: stranger.id })).toEqual([])

        await removeMember(tx, { userId: owner.id }, project.id, members[0]!.id)
        await expectServiceError(getProject(tx, { userId: members[0]!.id }, project.id), 'NOT_FOUND')
        expect(await listMyProjects(tx, { userId: members[0]!.id })).toEqual([])
      })
    })

    it('owner/editor can edit; reviewer/viewer get FORBIDDEN; stale version gets 409', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'editor', 'viewer')
        const [editor, viewer] = firstTwo(members)
        const v2 = await updateProject(tx, { userId: editor.id }, project.id, { expectedVersion: 1, goal: '목표' })
        expect(v2).toMatchObject({ version: 2, goal: '목표', myRole: 'editor' })

        // 다른 탭이 version 1을 들고 저장하려 하면 409입니다.
        await expectServiceError(
          updateProject(tx, { userId: owner.id }, project.id, { expectedVersion: 1, title: '덮어쓰기' }),
          'CONFLICT',
          'version_conflict',
        )
        expect((await getProject(tx, { userId: owner.id }, project.id)).title).toBe('캡스톤 디자인')

        await expectServiceError(
          updateProject(tx, { userId: viewer.id }, project.id, { expectedVersion: 2, title: 'x' }),
          'FORBIDDEN',
        )
        const missing = await expectServiceError(updateProject(tx, { userId: owner.id }, project.id, { title: 'x' }), 'VALIDATION')
        expect(missing.fields).toEqual({ expectedVersion: 'required' })
      })
    })
  })

  describe('invitations', () => {
    it('only the owner invites, and never as owner', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'editor')
        await expectServiceError(
          createInvitation(tx, { userId: members[0]!.id }, project.id, { role: 'viewer' }),
          'FORBIDDEN',
        )
        const asOwner = await expectServiceError(
          createInvitation(tx, { userId: owner.id }, project.id, { role: 'owner' }),
          'VALIDATION',
        )
        expect(asOwner.fields).toEqual({ role: 'invalid' })
        const stranger = await createUser(tx)
        await expectServiceError(createInvitation(tx, { userId: stranger.id }, project.id, { role: 'viewer' }), 'NOT_FOUND')
      })
    })

    it('stores only the token hash, is single-use, and is listed without the token', async () => {
      await withRollback(async (tx) => {
        const { project, owner } = await teamWith(tx)
        const { token, invitation } = await createInvitation(tx, { userId: owner.id }, project.id, { role: 'reviewer' }, T0)
        expect(invitation.status).toBe('pending')
        const [row] = await tx.select().from(invitations).where(eq(invitations.id, invitation.id))
        expect(row?.tokenHash).not.toBe(token)
        expect(row?.expiresAt.getTime()).toBe(T0.getTime() + INVITATION_TTL_MS)

        const a = await createUser(tx)
        const b = await createUser(tx)
        expect(await acceptInvitation(tx, { userId: a.id }, { token }, T0)).toEqual({ projectId: project.id, role: 'reviewer' })
        expect((await getProject(tx, { userId: a.id }, project.id)).myRole).toBe('reviewer')
        await expectServiceError(acceptInvitation(tx, { userId: b.id }, { token }, T0), 'GONE')

        const list = await listInvitations(tx, { userId: owner.id }, project.id, T0)
        expect(list.map((i) => i.status)).toEqual(['used'])
        expect(JSON.stringify(list)).not.toContain(token)
        await expectServiceError(listInvitations(tx, { userId: a.id }, project.id), 'FORBIDDEN')

        const audits = await tx.select().from(auditEvents).where(eq(auditEvents.projectId, project.id))
        expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['invitation.create', 'invitation.accept']))
        expect(JSON.stringify(audits)).not.toContain(token)
      })
    })

    it('expired, revoked and unknown invitations all return GONE', async () => {
      await withRollback(async (tx) => {
        const { project, owner } = await teamWith(tx)
        const user = await createUser(tx)
        const expired = await createInvitation(tx, { userId: owner.id }, project.id, { role: 'viewer' }, T0)
        await expectServiceError(
          acceptInvitation(tx, { userId: user.id }, { token: expired.token }, new Date(T0.getTime() + INVITATION_TTL_MS)),
          'GONE',
          'link_unavailable',
        )

        const revoked = await createInvitation(tx, { userId: owner.id }, project.id, { role: 'viewer' }, T0)
        const dto = await revokeInvitation(tx, { userId: owner.id }, project.id, revoked.invitation.id, T0)
        expect(dto.status).toBe('revoked')
        await expectServiceError(acceptInvitation(tx, { userId: user.id }, { token: revoked.token }, T0), 'GONE', 'link_unavailable')
        await expectServiceError(
          revokeInvitation(tx, { userId: owner.id }, project.id, revoked.invitation.id, T0),
          'CONFLICT',
          'invitation_not_pending',
        )

        await expectServiceError(acceptInvitation(tx, { userId: user.id }, { token: 'A'.repeat(43) }, T0), 'GONE', 'link_unavailable')
        await expectServiceError(acceptInvitation(tx, { userId: user.id }, { token: 'bad token!' }, T0), 'GONE')
        await expectServiceError(getProject(tx, { userId: user.id }, project.id), 'NOT_FOUND')
      })
    })

    it('only the owner revokes; an invitation of another project is NOT_FOUND', async () => {
      await withRollback(async (tx) => {
        const one = await teamWith(tx, 'editor')
        const two = await teamWith(tx)
        const inv = await createInvitation(tx, { userId: one.owner.id }, one.project.id, { role: 'viewer' }, T0)
        await expectServiceError(
          revokeInvitation(tx, { userId: one.members[0]!.id }, one.project.id, inv.invitation.id),
          'FORBIDDEN',
        )
        await expectServiceError(revokeInvitation(tx, { userId: two.owner.id }, two.project.id, inv.invitation.id), 'NOT_FOUND')
      })
    })

    it('already-active member gets 409 and the token stays usable', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'editor')
        const { token } = await createInvitation(tx, { userId: owner.id }, project.id, { role: 'viewer' }, T0)
        await expectServiceError(acceptInvitation(tx, { userId: members[0]!.id }, { token }, T0), 'CONFLICT', 'already_member')
        await expectServiceError(acceptInvitation(tx, { userId: owner.id }, { token }, T0), 'CONFLICT', 'already_member')
        const newcomer = await createUser(tx)
        expect((await acceptInvitation(tx, { userId: newcomer.id }, { token }, T0)).role).toBe('viewer')
      })
    })

    it('a member who left can rejoin with a new invitation', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'editor')
        const member = members[0]!
        await leaveProject(tx, { userId: member.id }, project.id)
        const { token } = await createInvitation(tx, { userId: owner.id }, project.id, { role: 'viewer' }, T0)
        await acceptInvitation(tx, { userId: member.id }, { token }, T0)
        expect((await getProject(tx, { userId: member.id }, project.id)).myRole).toBe('viewer')
      })
    })
  })

  describe('members', () => {
    it('lists active members only, without emails', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'editor', 'viewer')
        await leaveProject(tx, { userId: members[1]!.id }, project.id)
        const list = await listMembers(tx, { userId: members[0]!.id }, project.id)
        expect(list.map((m) => [m.userId, m.role])).toEqual([
          [owner.id, 'owner'],
          [members[0]!.id, 'editor'],
        ])
        expect(JSON.stringify(list)).not.toContain('@')
      })
    })

    it('role change: owner only, never to owner, never on self/owner', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'editor', 'viewer')
        const [editor, viewer] = firstTwo(members)
        const list = await changeMemberRole(tx, { userId: owner.id }, project.id, viewer.id, { role: 'reviewer' })
        expect(list.find((m) => m.userId === viewer.id)?.role).toBe('reviewer')

        await expectServiceError(
          changeMemberRole(tx, { userId: editor.id }, project.id, viewer.id, { role: 'editor' }),
          'FORBIDDEN',
        )
        const toOwner = await expectServiceError(
          changeMemberRole(tx, { userId: owner.id }, project.id, viewer.id, { role: 'owner' }),
          'VALIDATION',
        )
        expect(toOwner.fields).toEqual({ role: 'invalid' })
        await expectServiceError(
          changeMemberRole(tx, { userId: owner.id }, project.id, owner.id, { role: 'editor' }),
          'CONFLICT',
          'owner_role_locked',
        )
        await expectServiceError(
          changeMemberRole(tx, { userId: owner.id }, project.id, crypto.randomUUID(), { role: 'editor' }),
          'NOT_FOUND',
        )
        const audits = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'member.role_change'))
        expect(audits.some((a) => a.projectId === project.id && a.metadata.to === 'reviewer')).toBe(true)
      })
    })

    it('remove: owner removes others (status removed), not self; editors cannot', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'editor', 'viewer')
        const [editor, viewer] = firstTwo(members)
        await expectServiceError(removeMember(tx, { userId: editor.id }, project.id, viewer.id), 'FORBIDDEN')
        await expectServiceError(removeMember(tx, { userId: owner.id }, project.id, owner.id), 'CONFLICT')
        await removeMember(tx, { userId: owner.id }, project.id, viewer.id)
        const [row] = await tx.select().from(projectMembers).where(eq(projectMembers.userId, viewer.id))
        expect(row?.status).toBe('removed')
        await expectServiceError(removeMember(tx, { userId: owner.id }, project.id, viewer.id), 'NOT_FOUND')
      })
    })

    it('leave: members can leave, the owner cannot until ownership is transferred', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'reviewer')
        await expectServiceError(leaveProject(tx, { userId: owner.id }, project.id), 'CONFLICT', 'owner_must_transfer')
        await leaveProject(tx, { userId: members[0]!.id }, project.id)
        await expectServiceError(getProject(tx, { userId: members[0]!.id }, project.id), 'NOT_FOUND')
        await expectServiceError(leaveProject(tx, { userId: members[0]!.id }, project.id), 'NOT_FOUND')
      })
    })

    it('transfer ownership: target becomes owner, previous owner becomes editor, owner_id updated', async () => {
      await withRollback(async (tx) => {
        const { project, owner, members } = await teamWith(tx, 'viewer', 'editor')
        const [viewer, editor] = firstTwo(members)
        await expectServiceError(
          transferOwnership(tx, { userId: editor.id }, project.id, { userId: viewer.id }),
          'FORBIDDEN',
        )
        const self = await expectServiceError(
          transferOwnership(tx, { userId: owner.id }, project.id, { userId: owner.id }),
          'VALIDATION',
        )
        expect(self.fields).toEqual({ userId: 'self' })
        const stranger = await createUser(tx)
        const notMember = await expectServiceError(
          transferOwnership(tx, { userId: owner.id }, project.id, { userId: stranger.id }),
          'VALIDATION',
        )
        expect(notMember.fields).toEqual({ userId: 'not_active_member' })

        await transferOwnership(tx, { userId: owner.id }, project.id, { userId: viewer.id })
        const [row] = await tx.select().from(projects).where(eq(projects.id, project.id))
        expect(row?.ownerId).toBe(viewer.id)
        expect(row?.version).toBe(2)
        expect((await getProject(tx, { userId: viewer.id }, project.id)).myRole).toBe('owner')
        expect((await getProject(tx, { userId: owner.id }, project.id)).myRole).toBe('editor')
        // 이전 owner는 이제 나갈 수 있고, 멤버 관리는 할 수 없습니다.
        await expectServiceError(removeMember(tx, { userId: owner.id }, project.id, editor.id), 'FORBIDDEN')
        await leaveProject(tx, { userId: owner.id }, project.id)
        const audits = await tx.select().from(auditEvents).where(eq(auditEvents.projectId, project.id))
        expect(audits.map((a) => a.action)).toEqual(
          expect.arrayContaining(['project.transfer_ownership', 'member.leave']),
        )
      })
    })
  })
})
