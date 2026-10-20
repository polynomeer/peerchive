/**
 * T-09 디스코드 연동 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 사용자·프로젝트·디스코드 id(무작위)의 행만 봅니다.
 */
import { randomInt } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  and,
  discordChannelBindings,
  discordCodes,
  discordNotices,
  discordPinRequests,
  eq,
  integrations,
  logEntries,
  logRevisions,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import {
  createLinkCode,
  findDiscordIntegration,
  getIntegrations,
  linkDiscordAccount,
  unlinkDiscord,
} from '../server/modules/discord/accounts'
import { bindChannel, createBindCode, listBindings, unbindChannel, updateBinding } from '../server/modules/discord/bindings'
import { captureLog, capturePin, countStoredPinContent, decidePin, expirePinRequests } from '../server/modules/discord/capture'
import { discordInteractionClientId } from '../server/modules/discord/client-id'
import { hashCode } from '../server/modules/discord/codes'
import { ackNotice, claimNotices, scheduleDueNotices } from '../server/modules/discord/notices'
import { getLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, withRollback } from './helpers'

const SITE = 'http://localhost:3100'
/** 2026-10-20(화) 12:00 KST. */
const T0 = new Date('2026-10-20T03:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))

/** 테스트마다 겹치지 않는 디스코드 snowflake. */
const snowflake = () => `${randomInt(1, 9)}${String(randomInt(0, 2 ** 47)).padStart(17, '0')}`

type Role = 'editor' | 'reviewer' | 'viewer'

async function team(db: DbExecutor, roles: Role[] = []) {
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

async function link(db: DbExecutor, userId: string, discordUserId = snowflake()) {
  const { code } = await createLinkCode(db, { userId }, T0)
  expect(await linkDiscordAccount(db, { discordUserId, code }, T0)).toEqual({ status: 'linked' })
  return discordUserId
}

/** owner 계정을 연결하고 새 채널에 프로젝트를 연결합니다. */
async function boundTeam(db: DbExecutor, roles: Role[] = []) {
  const ctx = await team(db, roles)
  const ownerDiscord = await link(db, ctx.owner.id)
  const guildId = snowflake()
  const channelId = snowflake()
  const { code } = await createBindCode(db, { userId: ctx.owner.id }, ctx.project.id, T0)
  expect(await bindChannel(db, { discordUserId: ownerDiscord, guildId, channelId, code }, SITE, T0)).toMatchObject({
    status: 'bound',
    projectTitle: '캡스톤 디자인',
  })
  return { ...ctx, ownerDiscord, guildId, channelId }
}

async function projectLogs(db: DbExecutor, projectId: string) {
  return db.select().from(logEntries).where(eq(logEntries.projectId, projectId))
}

async function count(db: DbExecutor, table: typeof integrations | typeof discordPinRequests, where: ReturnType<typeof eq>) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where)
  return row?.n ?? 0
}

describe.skipIf(!databaseUrl)('discord account linking (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('link codes are hashed, single-use and expire after 10 minutes', async () => {
    await withRollback(async (tx) => {
      const user = await createUser(tx)
      const { code, expiresAt } = await createLinkCode(tx, { userId: user.id }, T0)
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)
      expect(expiresAt).toBe(at(10).toISOString())
      const [row] = await tx.select().from(discordCodes).where(eq(discordCodes.userId, user.id))
      expect(row!.codeHash).toBe(hashCode('link', code))
      expect(JSON.stringify(row)).not.toContain(code)

      const discordUserId = snowflake()
      // 대소문자·하이픈·공백은 무시합니다.
      const typed = `${code.slice(0, 5).toLowerCase()}-${code.slice(5)} `
      expect(await linkDiscordAccount(tx, { discordUserId, code: typed }, at(9))).toEqual({ status: 'linked' })
      expect(await linkDiscordAccount(tx, { discordUserId: snowflake(), code }, at(9))).toEqual({ status: 'invalid_code' })
      expect((await findDiscordIntegration(tx, discordUserId))?.userId).toBe(user.id)

      const late = await createLinkCode(tx, { userId: user.id }, T0)
      expect(await linkDiscordAccount(tx, { discordUserId: snowflake(), code: late.code }, at(10))).toEqual({ status: 'invalid_code' })
      // bind 코드는 link로 쓸 수 없습니다(해시에 종류가 들어감).
      expect(await linkDiscordAccount(tx, { discordUserId: snowflake(), code: 'ZZZZZZZZZZ' }, T0)).toEqual({ status: 'invalid_code' })
      await expectServiceError(linkDiscordAccount(tx, { discordUserId: 'abc', code }, T0), 'VALIDATION')
    })
  })

  it('one Discord account per Peerchive account; relink replaces, another account cannot take it', async () => {
    await withRollback(async (tx) => {
      const a = await createUser(tx)
      const b = await createUser(tx)
      const discordA = await link(tx, a.id)

      const codeB = await createLinkCode(tx, { userId: b.id }, T0)
      expect(await linkDiscordAccount(tx, { discordUserId: discordA, code: codeB.code }, T0)).toEqual({
        status: 'discord_account_in_use',
      })
      // 실패한 시도는 코드를 쓰지 않습니다.
      const discordB = snowflake()
      expect(await linkDiscordAccount(tx, { discordUserId: discordB, code: codeB.code }, T0)).toEqual({ status: 'linked' })

      const again = await createLinkCode(tx, { userId: a.id }, T0)
      expect(await linkDiscordAccount(tx, { discordUserId: discordA, code: again.code }, T0)).toEqual({ status: 'already_linked' })
      const newDiscord = snowflake()
      const relink = await createLinkCode(tx, { userId: a.id }, T0)
      expect(await linkDiscordAccount(tx, { discordUserId: newDiscord, code: relink.code }, T0)).toEqual({ status: 'relinked' })
      expect(await findDiscordIntegration(tx, discordA)).toBeNull()
      expect(await getIntegrations(tx, { userId: a.id })).toEqual({
        discord: { linked: true, linkedAt: T0.toISOString(), externalIdHint: `…${newDiscord.slice(-4)}` },
      })

      await unlinkDiscord(tx, { userId: a.id }, at(1))
      await unlinkDiscord(tx, { userId: a.id }, at(2))
      expect(await findDiscordIntegration(tx, newDiscord)).toBeNull()
      expect((await getIntegrations(tx, { userId: a.id })).discord.linked).toBe(false)
      expect(await count(tx, integrations, eq(integrations.userId, a.id))).toBe(2)
    })
  })
})

describe.skipIf(!databaseUrl)('discord channel binding (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('only the owner creates bind codes and only their linked Discord account can use them', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await team(tx, ['editor'])
      const [editor] = members
      const stranger = await createUser(tx)
      await expectServiceError(createBindCode(tx, { userId: editor!.id }, project.id, T0), 'FORBIDDEN')
      await expectServiceError(createBindCode(tx, { userId: stranger.id }, project.id, T0), 'NOT_FOUND')

      const { code } = await createBindCode(tx, { userId: owner.id }, project.id, T0)
      const guildId = snowflake()
      const channelId = snowflake()
      const unlinked = snowflake()
      expect(await bindChannel(tx, { discordUserId: unlinked, guildId, channelId, code }, SITE, T0)).toEqual({ status: 'not_linked' })
      const editorDiscord = await link(tx, editor!.id)
      expect(await bindChannel(tx, { discordUserId: editorDiscord, guildId, channelId, code }, SITE, T0)).toEqual({
        status: 'invalid_code',
      })
      const ownerDiscord = await link(tx, owner.id)
      expect(await bindChannel(tx, { discordUserId: ownerDiscord, guildId, channelId, code, label: '#로그' }, SITE, T0)).toEqual({
        status: 'bound',
        projectTitle: '캡스톤 디자인',
        projectUrl: `${SITE}/projects/${project.id}`,
      })
      expect(await bindChannel(tx, { discordUserId: ownerDiscord, guildId, channelId, code }, SITE, T0)).toEqual({
        status: 'invalid_code',
      })
      const again = await createBindCode(tx, { userId: owner.id }, project.id, T0)
      expect(await bindChannel(tx, { discordUserId: ownerDiscord, guildId, channelId, code: again.code }, SITE, T0)).toMatchObject({
        status: 'already_bound',
      })

      // 다른 프로젝트는 같은 채널을 쓸 수 없습니다.
      const other = await createProject(tx, { userId: owner.id }, { title: '다른 과제', kind: 'team' })
      const otherCode = await createBindCode(tx, { userId: owner.id }, other.id, T0)
      expect(await bindChannel(tx, { discordUserId: ownerDiscord, guildId, channelId, code: otherCode.code }, SITE, T0)).toEqual({
        status: 'channel_taken',
      })

      const bindings = await listBindings(tx, { userId: editor!.id }, project.id)
      expect(bindings).toEqual([
        { id: expect.any(String), guildId, channelId, label: '#로그', summaryEnabled: false, createdAt: T0.toISOString() },
      ])
      await expectServiceError(listBindings(tx, { userId: stranger.id }, project.id), 'NOT_FOUND')
      await expectServiceError(updateBinding(tx, { userId: editor!.id }, bindings[0]!.id, { summaryEnabled: true }), 'FORBIDDEN')
      expect(await updateBinding(tx, { userId: owner.id }, bindings[0]!.id, { summaryEnabled: true })).toMatchObject({
        summaryEnabled: true,
      })
      await expectServiceError(unbindChannel(tx, { userId: editor!.id }, bindings[0]!.id), 'FORBIDDEN')
      await unbindChannel(tx, { userId: owner.id }, bindings[0]!.id, at(1))
      expect(await listBindings(tx, { userId: owner.id }, project.id)).toEqual([])
      await expectServiceError(unbindChannel(tx, { userId: owner.id }, bindings[0]!.id), 'NOT_FOUND')

      // 해제 뒤에는 다른 프로젝트가 그 채널을 쓸 수 있습니다.
      const later = await createBindCode(tx, { userId: owner.id }, other.id, at(2))
      expect(await bindChannel(tx, { discordUserId: ownerDiscord, guildId, channelId, code: later.code }, SITE, at(2))).toMatchObject({
        status: 'bound',
        projectTitle: '다른 과제',
      })
    })
  })
})

describe.skipIf(!databaseUrl)('discord /log capture (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('creates exactly one discord-sourced stuck log per interaction, even on retry (scenario B)', async () => {
    await withRollback(async (tx) => {
      const { owner, project, ownerDiscord, guildId, channelId } = await boundTeam(tx)
      const request = {
        interactionId: snowflake(),
        guildId,
        channelId,
        discordUserId: ownerDiscord,
        tag: 'stuck',
        text: 'CORS 에러',
      }
      const first = await captureLog(tx, request, SITE, T0)
      expect(first).toEqual({ status: 'created', logUrl: expect.stringMatching(new RegExp(`^${SITE}/projects/${project.id}#log-`)) })
      const second = await captureLog(tx, request, SITE, at(1))
      expect(second).toEqual({ status: 'duplicate', logUrl: first.logUrl })
      const rows = await projectLogs(tx, project.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tag: 'stuck',
        source: 'discord',
        authorId: owner.id,
        clientId: discordInteractionClientId(request.interactionId),
      })
      const log = await getLog(tx, { userId: owner.id }, rows[0]!.id)
      expect(log).toMatchObject({ source: 'discord', body: '', payload: { symptom: 'CORS 에러', timeBucket: 'lt30m' } })

      const long = 'x'.repeat(250)
      await captureLog(tx, { ...request, interactionId: snowflake(), text: long, timeBucket: 'half_day' }, SITE, T0)
      const [stuck] = await tx
        .select({ body: logRevisions.body, payload: logRevisions.payload })
        .from(logRevisions)
        .innerJoin(logEntries, eq(logEntries.currentRevisionId, logRevisions.id))
        .where(and(eq(logEntries.projectId, project.id), sql`${logRevisions.body} <> ''`))
      expect(stuck!.body).toBe(long)
      expect(stuck!.payload).toMatchObject({ symptom: `${'x'.repeat(199)}…`, timeBucket: 'half_day' })
    })
  })

  it('validates payloads through the build-log rules and stores nothing on error', async () => {
    await withRollback(async (tx) => {
      const { project, ownerDiscord, guildId, channelId } = await boundTeam(tx)
      const base = { guildId, channelId, discordUserId: ownerDiscord }
      const bad = await captureLog(
        tx,
        { ...base, interactionId: snowflake(), tag: 'decision', text: 'DB', fields: { options: 'PostgreSQL', criteria: '', choice: 'PG' } },
        SITE,
        T0,
      )
      expect(bad).toEqual({
        status: 'invalid',
        fields: { 'payload.options': 'too_few', 'payload.criteria': 'required' },
        projectUrl: `${SITE}/projects/${project.id}`,
      })
      expect(await captureLog(tx, { ...base, interactionId: snowflake(), tag: 'progress', text: '  ' }, SITE, T0)).toMatchObject({
        status: 'invalid',
        fields: { body: 'required' },
      })
      expect(await captureLog(tx, { ...base, interactionId: snowflake(), tag: 'solution', text: '프록시' }, SITE, T0)).toEqual({
        status: 'web_only',
        projectUrl: `${SITE}/projects/${project.id}`,
      })
      expect(await projectLogs(tx, project.id)).toHaveLength(0)

      const ok = await captureLog(
        tx,
        {
          ...base,
          interactionId: snowflake(),
          tag: 'decision',
          text: 'DB 고르기',
          fields: { options: 'PostgreSQL\n\nMongoDB\n', criteria: '팀 경험', choice: 'PostgreSQL' },
        },
        SITE,
        T0,
      )
      expect(ok.status).toBe('created')
      const [row] = await projectLogs(tx, project.id)
      expect((await getLog(tx, { userId: (await findDiscordIntegration(tx, ownerDiscord))!.userId }, row!.id)).payload).toEqual({
        options: ['PostgreSQL', 'MongoDB'],
        criteria: '팀 경험',
        choice: 'PostgreSQL',
      })
    })
  })

  it('ignores unbound channels, unlinked users and members without write access (nothing stored)', async () => {
    await withRollback(async (tx) => {
      const { project, members, guildId, channelId } = await boundTeam(tx, ['reviewer'])
      const reviewerDiscord = await link(tx, members[0]!.id)
      const outsider = await createUser(tx)
      const outsiderDiscord = await link(tx, outsider.id)
      const req = (discordUserId: string, overrides: Record<string, string> = {}) => ({
        interactionId: snowflake(),
        guildId,
        channelId,
        discordUserId,
        tag: 'progress',
        text: '진행',
        ...overrides,
      })
      expect(await captureLog(tx, req(snowflake()), SITE, T0)).toEqual({ status: 'not_linked' })
      expect(await captureLog(tx, req(reviewerDiscord), SITE, T0)).toEqual({ status: 'not_writer' })
      expect(await captureLog(tx, req(outsiderDiscord), SITE, T0)).toEqual({ status: 'not_writer' })
      expect(await captureLog(tx, req(reviewerDiscord, { channelId: snowflake() }), SITE, T0)).toEqual({ status: 'not_bound' })
      // 다른 서버(guild)에서 같은 채널 id를 주장해도 연결로 보지 않습니다.
      expect(await captureLog(tx, req(reviewerDiscord, { guildId: snowflake() }), SITE, T0)).toEqual({ status: 'not_bound' })
      expect(await projectLogs(tx, project.id)).toHaveLength(0)
    })
  })
})

describe.skipIf(!databaseUrl)('discord 📌 capture and approvals (PostgreSQL)', () => {
  afterAll(closeTestDb)

  const pin = (ctx: { guildId: string; channelId: string }, messageAuthorId: string, reactorId: string, messageId = snowflake()) => ({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    messageId,
    messageAuthorId,
    reactorId,
    content: '  배포 스크립트에서 환경 변수 누락을 찾음 ',
    attachmentCount: 1,
  })

  it("a self-📌 creates the author's progress log once", async () => {
    await withRollback(async (tx) => {
      const ctx = await boundTeam(tx)
      const input = pin(ctx, ctx.ownerDiscord, ctx.ownerDiscord)
      expect((await capturePin(tx, input, SITE, T0)).status).toBe('created')
      expect((await capturePin(tx, input, SITE, at(1))).status).toBe('duplicate')
      const rows = await projectLogs(tx, ctx.project.id)
      expect(rows).toHaveLength(1)
      const log = await getLog(tx, { userId: ctx.owner.id }, rows[0]!.id)
      expect(log).toMatchObject({
        tag: 'progress',
        source: 'discord',
        body: '배포 스크립트에서 환경 변수 누락을 찾음\n\n📎 첨부 1개는 디스코드에만 있습니다.',
        links: [{ url: `https://discord.com/channels/${ctx.guildId}/${ctx.channelId}/${input.messageId}`, title: '디스코드 메시지' }],
      })
      expect(await capturePin(tx, { ...input, messageId: snowflake(), content: ' ', attachmentCount: 0 }, SITE, T0)).toEqual({
        status: 'empty',
      })
    })
  })

  it("someone else's 📌 asks the author; nothing is logged until approval; approval logs as the author and clears content", async () => {
    await withRollback(async (tx) => {
      const ctx = await boundTeam(tx, ['editor'])
      const editor = ctx.members[0]!
      const editorDiscord = await link(tx, editor.id)
      const input = pin(ctx, editorDiscord, ctx.ownerDiscord)

      const res = await capturePin(tx, input, SITE, T0)
      expect(res).toEqual({
        status: 'approval_requested',
        approval: {
          requestId: expect.any(String),
          authorDiscordId: editorDiscord,
          expiresAt: new Date(T0.getTime() + days(2)).toISOString(),
          preview: '배포 스크립트에서 환경 변수 누락을 찾음 📎 첨부 1개는 디스코드에만 있습니다.',
          projectTitle: '캡스톤 디자인',
        },
      })
      expect(await projectLogs(tx, ctx.project.id)).toHaveLength(0)
      expect(await countStoredPinContent(tx, input.messageId)).toBe(1)
      expect((await capturePin(tx, { ...input, reactorId: ctx.ownerDiscord }, SITE, at(1))).status).toBe('already_requested')

      const requestId = res.approval!.requestId
      // 작성자가 아닌 사람의 결정은 없는 요청과 같습니다.
      expect(await decidePin(tx, { requestId, discordUserId: ctx.ownerDiscord, decision: 'approve' }, SITE, at(2))).toEqual({
        status: 'not_found',
      })
      const approved = await decidePin(tx, { requestId, discordUserId: editorDiscord, decision: 'approve' }, SITE, at(3))
      expect(approved).toEqual({ status: 'approved', logUrl: expect.stringContaining(`${SITE}/projects/${ctx.project.id}#log-`) })
      const rows = await projectLogs(tx, ctx.project.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ authorId: editor.id, source: 'discord', tag: 'progress' })
      expect(await countStoredPinContent(tx, input.messageId)).toBe(0)
      const [request] = await tx.select().from(discordPinRequests).where(eq(discordPinRequests.id, requestId))
      expect(request).toMatchObject({ status: 'approved', content: null, logEntryId: rows[0]!.id })

      expect(await decidePin(tx, { requestId, discordUserId: editorDiscord, decision: 'reject' }, SITE, at(4))).toEqual({
        status: 'already_decided',
      })
      // 승인 뒤 누가 다시 📌을 달아도 새 요청·로그가 생기지 않습니다.
      expect((await capturePin(tx, input, SITE, at(5))).status).toBe('duplicate')
      expect((await capturePin(tx, { ...input, reactorId: editorDiscord }, SITE, at(5))).status).toBe('duplicate')
      expect(await projectLogs(tx, ctx.project.id)).toHaveLength(1)
    })
  })

  it('rejection and expiry store no log and clear the message content', async () => {
    await withRollback(async (tx) => {
      const ctx = await boundTeam(tx, ['editor'])
      const editorDiscord = await link(tx, ctx.members[0]!.id)

      const rejected = pin(ctx, editorDiscord, ctx.ownerDiscord)
      const r1 = await capturePin(tx, rejected, SITE, T0)
      expect(await decidePin(tx, { requestId: r1.approval!.requestId, discordUserId: editorDiscord, decision: 'reject' }, SITE, at(1)))
        .toEqual({ status: 'rejected' })
      expect(await countStoredPinContent(tx, rejected.messageId)).toBe(0)
      expect((await capturePin(tx, rejected, SITE, at(2))).status).toBe('already_decided')

      const late = pin(ctx, editorDiscord, ctx.ownerDiscord)
      const r2 = await capturePin(tx, late, SITE, T0)
      const after48h = new Date(T0.getTime() + days(2) + minutes(1))
      expect(await decidePin(tx, { requestId: r2.approval!.requestId, discordUserId: editorDiscord, decision: 'approve' }, SITE, after48h))
        .toEqual({ status: 'expired' })
      expect(await countStoredPinContent(tx, late.messageId)).toBe(0)

      const swept = pin(ctx, editorDiscord, ctx.ownerDiscord)
      await capturePin(tx, swept, SITE, T0)
      expect(await expirePinRequests(tx, after48h)).toBeGreaterThanOrEqual(1)
      expect(await countStoredPinContent(tx, swept.messageId)).toBe(0)
      // 만료된 메시지에 다시 📌을 달면 새 요청이 열립니다.
      expect((await capturePin(tx, swept, SITE, after48h)).status).toBe('approval_requested')

      // 연결을 해제하면 대기 중 요청도 닫히고 내용이 지워집니다.
      const [binding] = await tx.select().from(discordChannelBindings).where(eq(discordChannelBindings.channelId, ctx.channelId))
      await unbindChannel(tx, { userId: ctx.owner.id }, binding!.id, after48h)
      expect(await countStoredPinContent(tx, swept.messageId)).toBe(0)

      expect(await projectLogs(tx, ctx.project.id)).toHaveLength(0)
    })
  })

  it('unlinked or non-member reactors and unlinked authors are ignored with nothing stored', async () => {
    await withRollback(async (tx) => {
      const ctx = await boundTeam(tx, ['viewer'])
      const viewerDiscord = await link(tx, ctx.members[0]!.id)
      const outsider = await createUser(tx)
      const outsiderDiscord = await link(tx, outsider.id)
      const unlinkedAuthor = snowflake()

      const cases = [
        [pin(ctx, ctx.ownerDiscord, snowflake()), 'not_linked'],
        [pin(ctx, ctx.ownerDiscord, outsiderDiscord), 'not_member'],
        [pin(ctx, unlinkedAuthor, ctx.ownerDiscord), 'author_unavailable'],
        // viewer는 로그를 쓸 수 없으므로 승인 요청 대상이 아닙니다.
        [pin(ctx, viewerDiscord, ctx.ownerDiscord), 'author_unavailable'],
        [pin(ctx, viewerDiscord, viewerDiscord), 'not_member'],
        [{ ...pin(ctx, ctx.ownerDiscord, ctx.ownerDiscord), channelId: snowflake() }, 'not_bound'],
      ] as const
      for (const [input, status] of cases) {
        expect(await capturePin(tx, input, SITE, T0)).toEqual({ status })
        expect(await count(tx, discordPinRequests, eq(discordPinRequests.messageId, input.messageId))).toBe(0)
      }
      expect(await projectLogs(tx, ctx.project.id)).toHaveLength(0)
    })
  })
})

describe.skipIf(!databaseUrl)('discord scheduled notices (PostgreSQL)', () => {
  afterAll(closeTestDb)

  const kst = (iso: string) => new Date(`${iso}+09:00`)
  const ownNotices = (db: DbExecutor, bindingId: string) =>
    db.select().from(discordNotices).where(eq(discordNotices.bindingId, bindingId))

  it('creates one reminder per binding and week, leases it, and summaries only when enabled', async () => {
    await withRollback(async (tx) => {
      const ctx = await boundTeam(tx)
      const [binding] = await tx.select().from(discordChannelBindings).where(eq(discordChannelBindings.channelId, ctx.channelId))
      const sunday = kst('2026-10-25T20:01:00')
      await scheduleDueNotices(tx, SITE, sunday)
      await scheduleDueNotices(tx, SITE, kst('2026-10-25T23:00:00'))
      await scheduleDueNotices(tx, SITE, kst('2026-10-26T11:00:00'))
      let rows = await ownNotices(tx, binding!.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: 'checkin_reminder', isoWeek: '2026-W43' })
      expect(rows[0]!.content).toContain(`${SITE}/projects/${ctx.project.id}#checkin`)

      const claimed = (await claimNotices(tx, SITE, kst('2026-10-25T20:02:00'))).notices.filter((n) => n.channelId === ctx.channelId)
      expect(claimed).toEqual([
        { id: rows[0]!.id, channelId: ctx.channelId, kind: 'checkin_reminder', isoWeek: '2026-W43', content: rows[0]!.content },
      ])
      // 임대 중(5분)에는 다시 주지 않고, 지나면 다시 줍니다(ack 전에 봇이 죽은 경우).
      const mine = async (now: Date) => (await claimNotices(tx, SITE, now)).notices.filter((n) => n.channelId === ctx.channelId)
      expect(await mine(kst('2026-10-25T20:04:00'))).toEqual([])
      expect(await mine(kst('2026-10-25T20:08:00'))).toHaveLength(1)
      expect(await ackNotice(tx, { id: rows[0]!.id, delivered: true, discordMessageId: '123456789' }, kst('2026-10-25T20:08:01'))).toEqual({
        status: 'ok',
      })
      expect(await mine(kst('2026-10-25T20:20:00'))).toEqual([])
      expect(await ackNotice(tx, { id: rows[0]!.id, delivered: true }, kst('2026-10-25T20:21:00'))).toEqual({ status: 'not_found' })

      // 주간 요약은 끄면 만들지 않고, 켜면 한 번만.
      const tuesday = kst('2026-10-27T10:05:00')
      await scheduleDueNotices(tx, SITE, tuesday)
      expect((await ownNotices(tx, binding!.id)).filter((n) => n.kind === 'weekly_summary')).toHaveLength(0)
      await updateBinding(tx, { userId: ctx.owner.id }, binding!.id, { summaryEnabled: true })
      await scheduleDueNotices(tx, SITE, tuesday)
      await scheduleDueNotices(tx, SITE, kst('2026-10-28T09:00:00'))
      rows = (await ownNotices(tx, binding!.id)).filter((n) => n.kind === 'weekly_summary')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ isoWeek: '2026-W43' })
      expect(rows[0]!.content).toContain('[캡스톤 디자인]')
      expect(rows[0]!.content).toContain('※ 개수는 참고용이며 기여의 크기를 뜻하지 않습니다.')

      // 보내지 못하면 임대를 풀어 다시 시도합니다.
      const [summary] = await mine(kst('2026-10-27T10:06:00'))
      expect(await ackNotice(tx, { id: summary!.id, delivered: false }, kst('2026-10-27T10:06:30'))).toEqual({ status: 'ok' })
      expect(await mine(kst('2026-10-27T10:07:00'))).toHaveLength(1)
    })
  })
})
