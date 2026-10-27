/**
 * S-02 정체성 분리 경계 테스트(DELIVERY_PLAN §4.2 S-02·§5.2 Q·§7 GP 게이트, SYSTEM_DESIGN §6.7.1 PersonaActivity·§8.3 불변조건 1, ADR 0029).
 *
 * - DB 없이(모듈 의존 lint): social 모듈·프로필/페르소나를 내보내는 라우트와, 거기서 import로 닿는 모든 서버 파일이 커뮤니티 모듈과 커뮤니티 테이블
 *   (schema.ts의 커뮤니티 구역에서 읽음 — C-05와 같은 규칙이라 새 커뮤니티 테이블도 자동으로 덮음)을 import하지 않는지 소스를 읽어 확인합니다.
 *   저장소에 ESLint가 없어 이 테스트가 CI lint 역할을 합니다.
 * - DB(DATABASE_URL): social DB 역할(peerchive_social)의 권한(커뮤니티 테이블 권한 0, 소셜 읽기 테이블 SELECT), 그 역할로 실제 공개 프로필 읽기,
 *   작성 시점 페르소나·투영 트리거, 그리고 무작위(시드 고정) 사용자·페르소나·공간·글 조합에서 모든 페르소나의 공개 응답·활동 목록에
 *   0~1단계 글의 id·본문·본문 해시·작성 시각이 0건인지 보는 속성 기반 회귀 테스트.
 * 각 DB 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교·사용자만 봅니다.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createApp, createRouter, toWebHandler } from 'h3'
import { afterAll, describe, expect, it } from 'vitest'
import { NAME_MODE_CHANGE_DELAY_MS } from '@peerchive/domain'
import { communityComments, communityPosts, communitySpaces, eq, operators, personaActivities, personas, sql, type DbExecutor } from '@peerchive/db'
import { applyNameModeChange } from '../../worker/src/ops/name-modes'
import { createSchool } from '../server/modules/catalog/catalog'
import { joinSpace } from '../server/modules/community/memberships'
import { scheduleNameModeChange } from '../server/modules/community/name-modes'
import { createOfficialPage } from '../server/modules/community/official'
import { createComment, createPost } from '../server/modules/community/posts'
import { createRoom } from '../server/modules/community/spaces'
import { getPublicProfile, updateRealName, upsertProfile } from '../server/modules/identity/profiles'
import { createPublicProfileHandler, createReadmeCardHandler } from '../server/modules/portfolio/public-http'
import { listPersonaActivities, projectPersonaActivity } from '../server/modules/social/activities'
import { createDisplayPersona, listMyPersonas, resolvePublicPersona, setIdentityLink } from '../server/modules/social/personas'
import { COMMUNITY_TABLES } from './community-tables'
import { closeTestDb, createUser, databaseUrl, expectServiceError, verifiedAffiliation, withRollback } from './helpers'

const ROOT = resolve(__dirname, '../../..')
const WEB = resolve(__dirname, '..')
const SERVER = join(WEB, 'server')
const rel = (file: string) => relative(join(ROOT, 'apps'), file)

const listTs = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (name === 'node_modules' || name.startsWith('.')) return []
        return statSync(path).isDirectory() ? listTs(path) : name.endsWith('.ts') ? [path] : []
      })
    : []

// ── 모듈 의존 lint(소스) ──────────────────────────────────────────────────

const COMMUNITY_EXPORTS = new Set(COMMUNITY_TABLES.map((t) => t.exportName))
const COMMUNITY_NAME_PATTERN = new RegExp(`\\b(${COMMUNITY_TABLES.flatMap((t) => [t.exportName, t.sqlName]).join('|')})\\b`)

interface ImportRef {
  spec: string
  /** 중괄호 안에서 가져온 이름(별칭 앞의 원래 이름, `type` 접두 제거). */
  names: string[]
  /** 중괄호 없는 가져오기(기본·`* as`·동적 import). 테이블 이름을 확인할 수 없으므로 @peerchive/db에 쓰면 위반입니다. */
  opaque: boolean
}

/** 정적 import·re-export·부수효과 import·동적 import를 읽습니다(주석 줄의 "import" 단어는 줄 머리가 아니라 잡히지 않음). */
export function parseImports(text: string): ImportRef[] {
  const out: ImportRef[] = []
  for (const m of text.matchAll(/(?:^|\n)[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?([^;'"]*?)[ \t\n]*from[ \t]*['"]([^'"]+)['"]/g)) {
    const braces = m[1]!.match(/\{([\s\S]*)\}/)
    const names = braces
      ? braces[1]!
          .split(',')
          .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
          .filter(Boolean)
      : []
    out.push({ spec: m[2]!, names, opaque: !braces || /\*\s+as\s+/.test(m[1]!) })
  }
  for (const m of text.matchAll(/(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g)) out.push({ spec: m[1]!, names: [], opaque: false })
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1]!, names: [], opaque: true })
  return out
}

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return null
}

const isCommunityModule = (spec: string, resolved: string | null) =>
  /(^|\/)modules\/community(\/|$)|(^|\/)api\/v1\/(operator\/)?community(\/|$)/.test(spec) ||
  (resolved !== null && (resolved.startsWith(join(SERVER, 'modules/community')) || resolved.startsWith(join(SERVER, 'api/v1/community'))))

/** 파일 하나의 위반: 커뮤니티 모듈 import, @peerchive/db의 커뮤니티 테이블 import, @peerchive/db의 불투명 import, (strict면) 본문의 커뮤니티 테이블 이름. */
export function boundaryViolations(file: string, text: string, strict: boolean): string[] {
  const out: string[] = []
  for (const imp of parseImports(text)) {
    if (isCommunityModule(imp.spec, resolveLocal(file, imp.spec))) out.push(`imports community module ${imp.spec}`)
    if (imp.spec === '@peerchive/db' || imp.spec.startsWith('@peerchive/db/')) {
      if (imp.opaque) out.push(`opaque import of ${imp.spec}`)
      for (const name of imp.names) if (COMMUNITY_EXPORTS.has(name)) out.push(`imports community table ${name}`)
    }
  }
  if (strict) {
    const m = text.match(COMMUNITY_NAME_PATTERN)
    if (m) out.push(`names community table ${m[1]}`)
  }
  return out
}

/** 프로필·페르소나(·이후 팔로우·피드·활동)를 내보내는 라우트. 새 라우트도 이름으로 자동 포함됩니다. */
const SOCIAL_ROUTE = /(^|\/)(personas?|profiles?|profile\.[a-z]+\.ts|identity-link[^/]*|follows?|followers|following|feeds?|activit(y|ies))(\/|\.|$)/
const SOCIAL_ROUTES = listTs(join(SERVER, 'api')).filter((f) => SOCIAL_ROUTE.test(relative(join(SERVER, 'api'), f)))
const SOCIAL_MODULE = listTs(join(SERVER, 'modules/social'))
/** 공개 프로필·포트폴리오 경로가 페르소나를 푸는 곳(S-01). */
const PUBLIC_PROFILE_ENTRIES = ['modules/identity/profiles.ts', 'modules/portfolio/public-profile.ts', 'modules/portfolio/public-http.ts'].map((p) => join(SERVER, p))

function closure(roots: string[]): string[] {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const imp of parseImports(readFileSync(file, 'utf8'))) {
      const next = resolveLocal(file, imp.spec)
      if (next) visit(next)
    }
  }
  roots.forEach(visit)
  return [...seen]
}

describe('S-02 module boundary lint: social never reaches community posts (source)', () => {
  it('the scanner reads multi-line, aliased, type, namespace and dynamic imports (self-check)', () => {
    const file = join(SERVER, 'modules/social/fake.ts')
    const text = [
      "import {\n  and,\n  communityPosts as posts,\n  type threadAliases,\n} from '@peerchive/db'",
      "import { listBoardPosts } from '../community/posts'",
      "import * as db from '@peerchive/db'",
      "const x = await import('../../modules/community/archive-transfers')",
      ' * import { communityComments } from "@peerchive/db" — 주석 줄은 import가 아님',
      'const q = sql`select 1 from community_comments`',
    ].join('\n')
    const v = boundaryViolations(file, text, true)
    expect(v).toEqual(
      expect.arrayContaining([
        'imports community table communityPosts',
        'imports community table threadAliases',
        'imports community module ../community/posts',
        'opaque import of @peerchive/db',
        'imports community module ../../modules/community/archive-transfers',
        expect.stringMatching(/^names community table /),
      ]),
    )
    expect(boundaryViolations(file, "import { and, personas } from '@peerchive/db'\nimport { x } from '../identity/profiles'", true)).toEqual([])
    // 커뮤니티 구역 테이블은 스키마에서 읽음(C-04·C-06·C-09의 글 테이블이 모두 포함).
    for (const name of ['communityPosts', 'communityComments', 'threadAliases', 'communityReactions', 'archiveTransfers', 'archiveTransferConsents', 'communityAuthorLookups', 'nameModeChanges', 'studyRecords'])
      expect(COMMUNITY_EXPORTS.has(name), name).toBe(true)
    // 소셜 쪽 테이블은 커뮤니티 구역이 아님.
    for (const name of ['personas', 'profiles', 'identityLinks', 'personaActivities']) expect(COMMUNITY_EXPORTS.has(name), name).toBe(false)
  })

  it('the social module and the profile/persona routes neither import community code/tables nor name a community table', () => {
    expect(SOCIAL_MODULE.map(rel)).toEqual(expect.arrayContaining(['web/server/modules/social/personas.ts', 'web/server/modules/social/activities.ts']))
    expect(SOCIAL_ROUTES.map(rel)).toEqual(
      expect.arrayContaining([
        'web/server/api/v1/personas/index.post.ts',
        'web/server/api/v1/me/identity-link.put.ts',
        'web/server/api/v1/me/personas.get.ts',
        'web/server/api/v1/profiles/[handle].get.ts',
        'web/server/api/v1/public/profiles/[handle]/index.get.ts',
        'web/server/api/v1/public/profiles/[handle]/readme-card.md.get.ts',
      ]),
    )
    const offenders = [...SOCIAL_MODULE, ...SOCIAL_ROUTES].flatMap((f) => boundaryViolations(f, readFileSync(f, 'utf8'), true).map((v) => `${rel(f)}: ${v}`))
    expect(offenders).toEqual([])
  })

  it('nothing reachable by import from the social module, the profile/persona routes or the public profile/portfolio paths imports community code or tables', () => {
    const files = closure([...SOCIAL_MODULE, ...SOCIAL_ROUTES, ...PUBLIC_PROFILE_ENTRIES])
    // 공개 포트폴리오 경로는 판·케이스·release·학교 인증 모듈까지 닿습니다(그 전부가 검사 대상).
    expect(files.length).toBeGreaterThan(25)
    expect(files.map(rel)).toEqual(expect.arrayContaining(['web/server/modules/portfolio/editions.ts', 'web/server/modules/publication/public-read.ts']))
    const offenders = files.flatMap((f) => {
      // 서버 파일은 본문의 테이블 이름까지(공유 타입 파일은 DTO 필드 이름이 겹칠 수 있어 import만).
      const strict = f.startsWith(SERVER)
      return boundaryViolations(f, readFileSync(f, 'utf8'), strict).map((v) => `${rel(f)}: ${v}`)
    })
    expect(offenders).toEqual([])
  })
})

// ── DB 도우미 ────────────────────────────────────────────────────────────

const T0 = new Date('2026-11-10T09:00:00Z')
const HOUR = 60 * 60 * 1000

/** 오류(drizzle이 감싼 것 포함)의 PostgreSQL SQLSTATE. */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** savepoint 안에서 실패해야 하는 문장. 실패의 SQLSTATE를 돌려줍니다(바깥 트랜잭션은 계속 씀). */
async function failsWith(tx: DbExecutor, fn: (inner: DbExecutor) => Promise<unknown>): Promise<string | undefined> {
  try {
    await tx.transaction(async (inner) => {
      await fn(inner)
    })
  } catch (e) {
    return pgCode(e) ?? 'unknown'
  }
  return undefined
}

/** 공개 경로 전부(공개 프로필 JSON·README 카드 HTTP, 이전 공개 프로필 DTO)의 본문. */
async function publicBodies(db: DbExecutor, handle: string, now: Date): Promise<string> {
  const deps = { getDb: () => db, now: () => now, getEnv: () => ({}) }
  const web = toWebHandler(
    createApp().use(
      createRouter()
        .get('/api/v1/public/profiles/:handle', createPublicProfileHandler(deps))
        .get('/api/v1/public/profiles/:handle/readme-card.md', createReadmeCardHandler({ ...deps, getOrigin: () => 'https://peerchive.test' })),
    ),
  )
  const get = async (path: string) => {
    const res = await web(new Request(`http://localhost:3000${path}`))
    expect(res.status, path).toBe(200)
    return res.text()
  }
  return [
    await get(`/api/v1/public/profiles/${handle}`),
    await get(`/api/v1/public/profiles/${handle}/readme-card.md`),
    JSON.stringify(await getPublicProfile(db, handle)),
  ].join('\n')
}

/** 시드 고정 난수(mulberry32). 실패하면 메시지의 시드로 같은 조합을 다시 만듭니다. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// ── DB: social 역할 ───────────────────────────────────────────────────────

const SOCIAL_ROLE = 'peerchive_social'
/** social 읽기 경로가 쓰는 테이블(migration 0027 peerchive_apply_social_grants). */
const SOCIAL_READ_TABLES = ['personas', 'profiles', 'identity_links', 'persona_activities']

describe.skipIf(!databaseUrl)('S-02 social DB role (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('peerchive_social cannot log in, has no privilege at all on any community table, and reads only the social tables and public account columns', async () => {
    await withRollback(async (tx) => {
      const [role] = (await tx.execute(sql`select rolcanlogin, rolsuper from pg_roles where rolname = ${SOCIAL_ROLE}`)) as unknown as Array<{ rolcanlogin: boolean; rolsuper: boolean }>
      expect(role).toEqual({ rolcanlogin: false, rolsuper: false })
      expect(COMMUNITY_TABLES.length).toBeGreaterThanOrEqual(19)
      for (const t of COMMUNITY_TABLES) {
        const [p] = (await tx.execute(
          sql`select has_table_privilege(${SOCIAL_ROLE}, ${`public.${t.sqlName}`}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as tbl,
                     has_any_column_privilege(${SOCIAL_ROLE}, ${`public.${t.sqlName}`}, 'SELECT,INSERT,UPDATE,REFERENCES') as col`,
        )) as unknown as Array<{ tbl: boolean; col: boolean }>
        expect(p, t.sqlName).toEqual({ tbl: false, col: false })
      }
      for (const t of SOCIAL_READ_TABLES) {
        const [p] = (await tx.execute(
          sql`select has_table_privilege(${SOCIAL_ROLE}, ${`public.${t}`}, 'SELECT') as sel,
                     has_table_privilege(${SOCIAL_ROLE}, ${`public.${t}`}, 'INSERT,UPDATE,DELETE,TRUNCATE') as write`,
        )) as unknown as Array<{ sel: boolean; write: boolean }>
        expect(p, t).toEqual({ sel: true, write: false })
      }
      const cols = (await tx.execute(
        sql`select column_name, has_column_privilege(${SOCIAL_ROLE}, 'public.users', column_name, 'SELECT') as sel
            from information_schema.columns where table_schema = 'public' and table_name = 'users' order by column_name`,
      )) as unknown as Array<{ column_name: string; sel: boolean }>
      expect(cols.filter((c) => c.sel).map((c) => c.column_name)).toEqual(['display_name', 'id', 'status'])
      // 원천 테이블(선배 노트·공개 후보)도 social 역할은 읽지 않습니다(투영 검사는 트리거가 테이블 주인 권한으로).
      for (const t of ['senior_notes', 'publication_candidates', 'course_qa_items', 'audit_events'])
        expect((await tx.execute(sql`select has_table_privilege(${SOCIAL_ROLE}, ${`public.${t}`}, 'SELECT') as sel`))[0], t).toEqual({ sel: false })
    })
  })

  it('SET ROLE peerchive_social: SELECT on community posts/comments/thread aliases/archive transfers is denied, the social read path works', async () => {
    await withRollback(async (tx) => {
      const user = await createUser(tx, { displayName: '역할 시험', handle: `role-${crypto.randomUUID().slice(0, 8)}` })
      const [persona] = await tx.select().from(personas).where(eq(personas.userId, user.id))
      const expected = await getPublicProfile(tx, persona!.handle)

      for (const table of ['community_posts', 'community_comments', 'thread_aliases', 'archive_transfers', 'archive_transfer_consents', 'community_reactions', 'community_spaces']) {
        const code = await failsWith(tx, async (inner) => {
          await inner.execute(sql.raw(`set local role ${SOCIAL_ROLE}`))
          await inner.execute(sql.raw(`select 1 from public.${table} limit 1`))
        })
        expect(code, table).toBe('42501') // insufficient_privilege
      }
      // 계정의 이메일·실명 열도 거부.
      expect(
        await failsWith(tx, async (inner) => {
          await inner.execute(sql.raw(`set local role ${SOCIAL_ROLE}`))
          await inner.execute(sql.raw('select private_email from public.users limit 1'))
        }),
      ).toBe('42501')

      // 같은 역할로 실제 social 읽기 경로(공개 페르소나 찾기·연결·이전 공개 프로필 DTO·활동 목록)는 그대로 동작.
      await tx.transaction(async (inner) => {
        await inner.execute(sql.raw(`set local role ${SOCIAL_ROLE}`))
        expect((await inner.execute(sql`select current_user as u`))[0]).toEqual({ u: SOCIAL_ROLE })
        await inner.execute(sql.raw('select 1 from public.persona_activities limit 1'))
        await inner.execute(sql.raw('select 1 from public.personas limit 1'))
        expect((await resolvePublicPersona(inner, persona!.handle)).persona.id).toBe(persona!.id)
        expect(await getPublicProfile(inner, persona!.handle)).toEqual(expected)
        expect(await listPersonaActivities(inner, persona!.id)).toEqual([])
        await inner.execute(sql.raw('reset role'))
      })
    })
  })
})

// ── DB: 작성 시점 페르소나·투영 트리거 ────────────────────────────────────

type Mode = 'real' | 'display' | 'anonymous'

interface Person {
  userId: string
  real: { id: string; handle: string } | null
  display: { id: string; handle: string } | null
}

async function makeSchool(tx: DbExecutor, tag: string) {
  const op = await createUser(tx, { displayName: '운영자' })
  await tx.insert(operators).values({ userId: op.id })
  const s = await createSchool(tx, { userId: op.id }, { name: `경계${tag}학교`, confirmNew: true }, T0)
  return { opId: op.id, schoolId: s.id }
}

async function makePerson(tx: DbExecutor, schoolId: string, tag: string, opts: { real: boolean; display: boolean; link: boolean }): Promise<Person> {
  const u = await createUser(tx, { displayName: `계정${tag}` })
  const actor = { userId: u.id }
  await verifiedAffiliation(tx, u.id, schoolId)
  await updateRealName(tx, actor, { realName: `실명${tag}` })
  let real: Person['real'] = null
  let display: Person['display'] = null
  if (opts.real) {
    const handle = `r-${tag}`
    await upsertProfile(tx, actor, { handle, displayName: `계정${tag}`, headline: `소개 ${tag}` })
    real = { id: (await listMyPersonas(tx, actor)).personas.find((p) => p.kind === 'real')!.id, handle }
    if (opts.display) {
      const dHandle = `d-${tag}`
      const created = await createDisplayPersona(tx, actor, { handle: dHandle, displayName: `밤의개발자${tag}`, headline: `표시명 소개 ${tag}` }, T0)
      display = { id: created.id, handle: dHandle }
      if (opts.link) await setIdentityLink(tx, actor, { visible: true }, T0)
    }
  }
  return { userId: u.id, real, display }
}

describe.skipIf(!databaseUrl)('S-02 write-time persona and projection guard (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('posts/comments fix the persona of the same kind at write time; anonymous never has one; the DB rejects mismatches and later changes', async () => {
    await withRollback(async (tx) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const { schoolId } = await makeSchool(tx, tag)
      const A = await makePerson(tx, schoolId, `${tag}a`, { real: true, display: true, link: false })
      const B = await makePerson(tx, schoolId, `${tag}b`, { real: true, display: false, link: false })
      const rooms: Record<Mode, { boardId: string; slug: string }> = {} as never
      for (const mode of ['real', 'display', 'anonymous'] as const) {
        const r = await createRoom(tx, { userId: A.userId }, { name: `방 ${mode} ${tag}`, nameMode: mode, joinPolicy: 'open' }, T0)
        await joinSpace(tx, { userId: B.userId }, r.slug, T0)
        rooms[mode] = { boardId: r.boards[0]!.id, slug: r.slug }
      }
      const write = async (who: Person, mode: Mode, i: number) => {
        const post = await createPost(tx, { userId: who.userId }, rooms[mode].boardId, { title: `글 ${mode}`, body: `본문 ${mode} ${i}` }, new Date(T0.getTime() + i * HOUR))
        await createComment(tx, { userId: who.userId }, post.id, { body: `댓글 ${mode} ${i}` }, new Date(T0.getTime() + i * HOUR + 1000))
        const [row] = await tx.select().from(communityPosts).where(eq(communityPosts.id, post.id))
        const [comment] = await tx.select().from(communityComments).where(eq(communityComments.postId, post.id))
        return { post: row!, comment: comment! }
      }
      const aReal = await write(A, 'real', 1)
      const aDisplay = await write(A, 'display', 2)
      const aAnon = await write(A, 'anonymous', 3)
      expect([aReal.post.personaId, aReal.comment.personaId]).toEqual([A.real!.id, A.real!.id])
      expect([aDisplay.post.personaId, aDisplay.comment.personaId]).toEqual([A.display!.id, A.display!.id])
      expect([aAnon.post.personaId, aAnon.comment.personaId]).toEqual([null, null])
      // 표시명 페르소나가 없으면 실명 페르소나로 대신하지 않고 쓰기 자체를 막습니다(403 display_persona_required, ADR 0030).
      await expectServiceError(write(B, 'display', 4), 'FORBIDDEN', 'display_persona_required')
      // ADR 0030 이전에 페르소나 없이 쓴 표시명 글(persona_id null)
      const [bDisplayPost] = await tx
        .insert(communityPosts)
        .values({ boardId: rooms.display.boardId, spaceId: aDisplay.post.spaceId, authorId: B.userId, nameMode: 'display', personaId: null, title: 't', body: 'b' })
        .returning()
      const bDisplay = { post: bDisplayPost! }

      const base = { boardId: rooms.anonymous.boardId, spaceId: aAnon.post.spaceId, authorId: A.userId, title: 't', body: 'b' }
      // 익명 글에 페르소나: check 위반
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, nameMode: 'anonymous', personaId: A.real!.id }))).toBe('23514')
      // 표시명 글에 실명 페르소나, 남의 페르소나: 트리거 거부
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, nameMode: 'display', personaId: A.real!.id }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(communityPosts).values({ ...base, nameMode: 'real', personaId: B.real!.id }))).toBe('23514')
      expect(
        await failsWith(tx, (i) => i.insert(communityComments).values({ postId: aAnon.post.id, authorId: A.userId, nameMode: 'display', personaId: A.real!.id, body: 'x' })),
      ).toBe('23514')
      // 작성 뒤 페르소나를 붙이거나 바꾸지 못함(비우기만 가능 — 탈퇴 정리).
      expect(await failsWith(tx, (i) => i.update(communityPosts).set({ personaId: A.real!.id }).where(eq(communityPosts.id, bDisplay.post.id)))).toBe('23514')
      expect(await failsWith(tx, (i) => i.update(communityPosts).set({ personaId: A.display!.id }).where(eq(communityPosts.id, aReal.post.id)))).toBe('23514')
      expect(await failsWith(tx, (i) => i.update(communityPosts).set({ personaId: null }).where(eq(communityPosts.id, aReal.post.id)))).toBeUndefined()
    })
  })

  it('persona_activities: NOT NULL persona, only real/display listed published posts with their own write-time persona; anonymous has no path even by raw SQL', async () => {
    await withRollback(async (tx) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const { schoolId } = await makeSchool(tx, tag)
      const A = await makePerson(tx, schoolId, `${tag}a`, { real: true, display: true, link: true })
      const boards: Record<string, string> = {}
      const spaces: Record<string, string> = {}
      for (const [key, mode, discovery] of [['real', 'real', 'listed'], ['display', 'display', 'listed'], ['anonymous', 'anonymous', 'listed'], ['unlisted', 'real', 'unlisted']] as const) {
        const r = await createRoom(tx, { userId: A.userId }, { name: `투영 ${key} ${tag}`, nameMode: mode, joinPolicy: 'open', discovery }, T0)
        boards[key] = r.boards[0]!.id
        spaces[key] = r.slug
      }
      const post = async (key: string, i: number) => createPost(tx, { userId: A.userId }, boards[key]!, { title: `글 ${key}`, body: `본문 ${key}` }, new Date(T0.getTime() + i * HOUR))
      const pReal = await post('real', 1)
      const pDisplay = await post('display', 2)
      const pAnon = await post('anonymous', 3)
      const pUnlisted = await post('unlisted', 4)
      const facts = async (id: string) => {
        const [row] = await tx
          .select({ nameMode: communityPosts.nameMode, personaId: communityPosts.personaId, status: communityPosts.status, discovery: communitySpaces.discovery })
          .from(communityPosts)
          .innerJoin(communitySpaces, eq(communitySpaces.id, communityPosts.spaceId))
          .where(eq(communityPosts.id, id))
        return { type: 'community_post' as const, nameMode: row!.nameMode, personaId: row!.personaId, discovery: row!.discovery, published: row!.status === 'published' }
      }
      const project = async (p: { id: string }, personaId: string, at: number) =>
        projectPersonaActivity(tx, { personaId, sourceId: p.id, source: await facts(p.id), occurredAt: new Date(T0.getTime() + at * HOUR) })

      expect(await project(pReal, A.real!.id, 1)).toMatchObject({ projected: true })
      expect(await project(pReal, A.real!.id, 1)).toEqual({ projected: true, activityId: null }) // 한 번만
      expect(await project(pDisplay, A.display!.id, 2)).toMatchObject({ projected: true })
      expect(await project(pDisplay, A.real!.id, 2)).toEqual({ projected: false, reason: 'persona_mismatch' })
      expect(await project(pReal, A.display!.id, 1)).toEqual({ projected: false, reason: 'persona_mismatch' })
      expect(await project(pAnon, A.real!.id, 3)).toEqual({ projected: false, reason: 'anonymous' })
      expect(await project(pAnon, A.display!.id, 3)).toEqual({ projected: false, reason: 'anonymous' })
      expect(await project(pUnlisted, A.real!.id, 4)).toEqual({ projected: false, reason: 'unlisted_space' })

      // 사실을 속여 넘겨도(또는 SQL로 바로 넣어도) DB 트리거가 원본 행으로 거부합니다.
      const lie = { type: 'community_post' as const, nameMode: 'real' as const, personaId: A.real!.id, discovery: 'listed' as const, published: true }
      expect(await failsWith(tx, (i) => projectPersonaActivity(i, { personaId: A.real!.id, sourceId: pAnon.id, source: lie, occurredAt: T0 }))).toBe('23514')
      expect(await failsWith(tx, (i) => projectPersonaActivity(i, { personaId: A.real!.id, sourceId: pUnlisted.id, source: lie, occurredAt: T0 }))).toBe('23514')
      expect(await failsWith(tx, (i) => projectPersonaActivity(i, { personaId: A.real!.id, sourceId: pDisplay.id, source: lie, occurredAt: T0 }))).toBe('23514')
      for (const personaId of [A.real!.id, A.display!.id])
        expect(
          await failsWith(tx, (i) => i.insert(personaActivities).values({ personaId, sourceType: 'community_post', sourceId: pAnon.id, itemKind: 'posts' })),
          'raw anonymous insert',
        ).toBe('23514')
      // 없는 원천·아직 테이블이 없는 프로필 글·익명 노트 자리도 거부.
      expect(await failsWith(tx, (i) => i.insert(personaActivities).values({ personaId: A.real!.id, sourceType: 'senior_note', sourceId: pAnon.id, itemKind: 'notes_and_studies' }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.insert(personaActivities).values({ personaId: A.real!.id, sourceType: 'profile_post', sourceId: crypto.randomUUID(), itemKind: 'posts' }))).toBe('23514')
      expect(await failsWith(tx, (i) => i.execute(sql`insert into persona_activities (persona_id, source_type, source_id, item_kind) values (null, 'community_post', ${pReal.id}, 'posts')`))).toBe('23502')
      // 투영한 뒤에는 withdrawn_at만 바뀝니다.
      expect(await failsWith(tx, (i) => i.update(personaActivities).set({ personaId: A.display!.id }).where(eq(personaActivities.sourceId, pReal.id)))).toBe('23514')
      expect(await failsWith(tx, (i) => i.update(personaActivities).set({ withdrawnAt: T0 }).where(eq(personaActivities.sourceId, pReal.id)))).toBeUndefined()

      expect((await listPersonaActivities(tx, A.display!.id)).map((a) => a.sourceId)).toEqual([pDisplay.id])
    })
  })
})

// ── DB: 속성 기반 회귀 테스트(§8.3 회귀 테스트, DELIVERY_PLAN §5.2 Q) ─────────────────────

const WORLDS = Number(process.env.S02_PROPERTY_WORLDS ?? 6)
const BASE_SEED = Number(process.env.S02_PROPERTY_SEED ?? 20261028)

interface WrittenItem {
  kind: 'post' | 'comment'
  id: string
  postId: string
  authorId: string
  mode: Mode
  title: string | null
  body: string
  createdAt: Date
}

/**
 * 무작위 세계 하나: 학교·공식 페이지(익명 기본, 글마다 표시명 가능)·실명/표시명/익명 사용자 방(listed·unlisted)·익명에서 실명으로 바뀌는 방,
 * 실명 프로필이 있거나 없고 표시명 페르소나·연결 플래그가 있거나 없는 사용자, 모든 방식의 글·댓글. 그다음 원본 모듈이 하듯 모든 글을 작성자의 모든
 * 페르소나로 투영해 봅니다(규칙이 거름). 반환: 쓴 글·댓글과 사람들.
 */
async function buildWorld(tx: DbExecutor, seed: number) {
  const r = rng(seed)
  const tag = `${seed.toString(36)}${crypto.randomUUID().slice(0, 4)}`
  const { schoolId, opId } = await makeSchool(tx, tag)
  const people: Person[] = []
  const n = r.int(2, 4)
  for (let i = 0; i < n; i++) {
    const real = r.chance(0.85)
    people.push(await makePerson(tx, schoolId, `${tag}${i}`, { real, display: real && r.chance(0.6), link: r.chance(0.5) }))
  }
  type Space = { slug: string; boardId: string; official: boolean; mode: Mode; convertTo?: Mode }
  const spaces: Space[] = []
  const official = await createOfficialPage(tx, { userId: opId }, { schoolId }, T0)
  const officialBoard = official.boards.find((b) => b.kind !== 'notice')!
  spaces.push({ slug: official.slug, boardId: officialBoard.id, official: true, mode: 'anonymous' })
  const roomCount = r.int(2, 4)
  for (let i = 0; i < roomCount; i++) {
    const mode = r.pick(['real', 'display', 'anonymous'] as const)
    const owner = r.pick(people)
    const room = await createRoom(tx, { userId: owner.userId }, { name: `방${i} ${tag}`, nameMode: mode, joinPolicy: 'open', discovery: r.pick(['listed', 'unlisted'] as const) }, T0)
    for (const p of people) if (p !== owner) await joinSpace(tx, { userId: p.userId }, room.slug, T0)
    spaces.push({ slug: room.slug, boardId: room.boards[0]!.id, official: false, mode, ...(mode === 'anonymous' && r.chance(0.7) && { convertTo: r.pick(['real', 'display'] as const) }) })
  }

  const items: WrittenItem[] = []
  let clock = T0.getTime() + HOUR
  const tick = () => {
    clock += HOUR + r.int(1, 59_999)
    return new Date(clock)
  }
  /**
   * 표시명으로 쓰는 사람에게 표시명 페르소나가 없으면 403(ADR 0030)인지 확인하고, 있는 사람으로 바꿉니다(아무도 없으면 null → 건너뜀).
   * 공식 페이지는 고른 방식, 사용자 방은 지금 공간 방식(바뀐 뒤면 바뀐 방식)이 쓰는 방식입니다.
   */
  const writerFor = async (picked: Person, mode: Mode, attempt: () => Promise<unknown>): Promise<Person | null> => {
    if (mode !== 'display' || picked.display) return picked
    await expectServiceError(attempt(), 'FORBIDDEN', 'display_persona_required')
    const able = people.filter((p) => p.display)
    return able.length ? r.pick(able) : null
  }
  const writeRound = async (round: number) => {
    for (const space of spaces) {
      const posts = r.int(1, 3)
      for (let i = 0; i < posts; i++) {
        const requested = space.official ? r.pick(['anonymous', 'display'] as const) : undefined
        const marker = `S02-${seed}-${round}-${items.length}-${crypto.randomUUID().slice(0, 6)}`
        const at = tick()
        const input = { title: `제목 ${marker}`, body: `본문 ${marker}`, ...(requested && { nameMode: requested }) }
        const picked = r.pick(people)
        const author = await writerFor(picked, requested ?? space.mode, () => createPost(tx, { userId: picked.userId }, space.boardId, input, at))
        if (!author) continue
        const post = await createPost(tx, { userId: author.userId }, space.boardId, input, at)
        items.push({ kind: 'post', id: post.id, postId: post.id, authorId: author.userId, mode: post.nameMode, title: `제목 ${marker}`, body: `본문 ${marker}`, createdAt: at })
        const comments = r.int(0, 2)
        for (let c = 0; c < comments; c++) {
          const cMarker = `S02C-${seed}-${round}-${items.length}-${crypto.randomUUID().slice(0, 6)}`
          const cAt = tick()
          const cMode = space.official ? r.pick(['anonymous', 'display'] as const) : undefined
          const cInput = { body: `댓글 ${cMarker}`, ...(cMode && { nameMode: cMode }) }
          const pickedC = r.pick(people)
          const who = await writerFor(pickedC, cMode ?? space.mode, () => createComment(tx, { userId: pickedC.userId }, post.id, cInput, cAt))
          if (!who) continue
          const thread = await createComment(tx, { userId: who.userId }, post.id, cInput, cAt)
          const mine = thread.comments.flatMap((x) => [x, ...x.replies]).find((x) => x.body === `댓글 ${cMarker}`)!
          items.push({ kind: 'comment', id: mine.id, postId: post.id, authorId: who.userId, mode: mine.nameMode, title: null, body: `댓글 ${cMarker}`, createdAt: cAt })
        }
      }
    }
  }
  await writeRound(1)
  // 시나리오 Q: 방장이 익명 방을 실명(또는 표시명)으로 바꾼 뒤에도 이전 익명 글은 투영되지 않습니다.
  const converting = spaces.filter((s) => s.convertTo)
  if (converting.length) {
    for (const s of converting) {
      const [row] = await tx.select({ createdBy: communitySpaces.createdBy }).from(communitySpaces).where(eq(communitySpaces.slug, s.slug))
      const state = await scheduleNameModeChange(tx, { userId: row!.createdBy }, s.slug, { toMode: s.convertTo }, new Date(clock))
      await applyNameModeChange(tx, state.pending!.id, { now: new Date(clock + NAME_MODE_CHANGE_DELAY_MS + 60_000) })
      s.mode = s.convertTo!
    }
    clock += NAME_MODE_CHANGE_DELAY_MS + 2 * HOUR
  }
  await writeRound(2)

  // 원본 모듈(outbox 처리)이 하듯: 모든 글을 작성자의 모든 페르소나로 투영 시도(규칙이 거름).
  for (const item of items.filter((i) => i.kind === 'post')) {
    const [row] = await tx
      .select({ nameMode: communityPosts.nameMode, personaId: communityPosts.personaId, status: communityPosts.status, discovery: communitySpaces.discovery })
      .from(communityPosts)
      .innerJoin(communitySpaces, eq(communitySpaces.id, communityPosts.spaceId))
      .where(eq(communityPosts.id, item.id))
    const author = people.find((p) => p.userId === item.authorId)!
    for (const persona of [author.real, author.display]) {
      if (!persona) continue
      await projectPersonaActivity(tx, {
        personaId: persona.id,
        sourceId: item.id,
        source: { type: 'community_post', nameMode: row!.nameMode, personaId: row!.personaId, discovery: row!.discovery, published: row!.status === 'published' },
        occurredAt: item.createdAt,
      })
    }
  }
  return { people, items, now: new Date(clock + HOUR) }
}

describe.skipIf(!databaseUrl)('S-02 property: anonymous posts never reach a persona (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it(`for ${WORLDS} seeded random worlds, every persona's public JSON, README card, old profile DTO and activity list carry 0 anonymous post ids, bodies, body hashes or timestamps`, async () => {
    const totals = { worlds: 0, personas: 0, anonymous: 0, projected: 0 }
    for (let w = 0; w < WORLDS; w++) {
      const seed = BASE_SEED + w
      await withRollback(async (tx) => {
        const { people, items, now } = await buildWorld(tx, seed)
        const anonymous = items.filter((i) => i.mode === 'anonymous')
        const forbidden = anonymous.flatMap((i) => [
          i.id,
          i.body,
          ...(i.title ? [i.title, sha256(i.title)] : []),
          sha256(i.body),
          i.createdAt.toISOString(),
          String(i.createdAt.getTime()),
        ])
        const postRows = await tx
          .select({ id: communityPosts.id, personaId: communityPosts.personaId, nameMode: communityPosts.nameMode, discovery: communitySpaces.discovery })
          .from(communityPosts)
          .innerJoin(communitySpaces, eq(communitySpaces.id, communityPosts.spaceId))
          .where(sql`${communityPosts.id} in ${items.filter((i) => i.kind === 'post').map((i) => i.id)}`)
        for (const p of people) {
          for (const [kind, persona] of [['real', p.real], ['display', p.display]] as const) {
            if (!persona) continue
            const activities = await listPersonaActivities(tx, persona.id)
            const body = [await publicBodies(tx, persona.handle, now), JSON.stringify(activities)].join('\n')
            for (const value of forbidden) expect(body.includes(value), `seed ${seed} ${kind} @${persona.handle} leaks ${value.slice(0, 24)}`).toBe(false)
            // 활동 목록은 정확히 "이 페르소나로 작성 시점에 고정된, listed 공간의 같은 종류 방식 글"뿐(다른 종류·익명·unlisted 없음).
            const expected = postRows.filter((r) => r.personaId === persona.id && r.nameMode === kind && r.discovery === 'listed').map((r) => r.id)
            expect(activities.map((a) => a.sourceId).sort(), `seed ${seed} ${kind} @${persona.handle} activities`).toEqual(expected.sort())
            totals.personas++
            totals.projected += activities.length
          }
        }
        // DB 전체로도: 이 세계의 익명 글은 어떤 페르소나 활동에도 없고, 익명 글·댓글의 persona_id는 모두 null.
        const anonIds = anonymous.map((i) => i.id)
        if (anonIds.length) {
          const [leaked] = (await tx.execute(sql`select count(*)::int as n from persona_activities where source_id in ${anonIds}`)) as unknown as Array<{ n: number }>
          expect(leaked!.n, `seed ${seed}`).toBe(0)
          const [attributed] = (await tx.execute(
            sql`select (select count(*) from community_posts where id in ${anonIds} and persona_id is not null) + (select count(*) from community_comments where id in ${anonIds} and persona_id is not null) as n`,
          )) as unknown as Array<{ n: number }>
          expect(Number(attributed!.n), `seed ${seed}`).toBe(0)
        }
        totals.worlds++
        totals.anonymous += anonymous.length
      })
    }
    // 생성기가 실제로 익명 글과 투영된 글을 모두 만들었는지(빈 세계로 통과하지 않게).
    expect(totals.worlds).toBe(WORLDS)
    expect(totals.anonymous).toBeGreaterThan(WORLDS)
    expect(totals.projected).toBeGreaterThan(0)
    expect(totals.personas).toBeGreaterThan(WORLDS)
  })
})
