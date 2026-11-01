/**
 * C-05 커뮤니티 열람 범위·검색엔진 비노출 테스트(DELIVERY_PLAN §4.1 C-05, §7 GC 게이트, SYSTEM_DESIGN §8.2·§11, ADR 0021).
 *
 * - DB 없이: HTTP 경계(비로그인 화면 404 고정 HTML·API 401·헤더·링크 미리보기 봇), robots.txt(두 색인 설정), 소스 경계(커뮤니티 테이블을
 *   schema.ts의 커뮤니티 구역에서 읽어 C-04 이후 테이블도 자동으로 포함), 사이트맵 가드, 분석 허용 목록, 화면 머리말(OG·제목) 가드.
 * - DB(DATABASE_URL): 행위자 × 경로 매트릭스(모두 404), 소개(preview) 내용, 센티넬(커뮤니티 밖 모든 테이블·공개 조회에 0건),
 *   커뮤니티 감사 기록·분석 이벤트의 형식(id·종류만).
 * 각 DB 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교(무작위 이름)·사용자만 봅니다.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ANALYTICS_EVENT_NAMES, ANALYTICS_PROP_SPECS, sanitizeAnalyticsProps } from '@peerchive/domain'
import { analyticsEvents, and, auditEvents, inArray, operators, sql, type DbExecutor } from '@peerchive/db'
import { removeAffiliation } from '../server/modules/affiliation/affiliations'
import { setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import {
  COMMUNITY_NOT_FOUND_HTML,
  COMMUNITY_PAGE_TITLE,
  COMMUNITY_ROBOTS,
  createCommunityGuard,
  isCommunityApiPath,
  isCommunityPagePath,
} from '../server/modules/community/http'
import { acceptSpaceInvitation, createSpaceInvitation, listSpaceInvitations, previewSpaceInvitation } from '../server/modules/community/invitations'
import { joinSpace, leaveSpace, listMembers, removeMember } from '../server/modules/community/memberships'
import { getNameModeState, scheduleNameModeChange } from '../server/modules/community/name-modes'
import { listMyCommunityNotices } from '../server/modules/community/notices'
import { createOfficialPage } from '../server/modules/community/official'
import { createComment, createPost, editPost, getPost, listBoardPosts, setReaction } from '../server/modules/community/posts'
import {
  applyToRecruitment,
  createRecruitment,
  getRecruitment,
  issueRecruitmentInvitation,
  listApplications,
  listRecruitments,
  withdrawApplication,
} from '../server/modules/community/recruitments'
import { updateRealName } from '../server/modules/identity/profiles'
import {
  resolveReportableApplication,
  resolveReportableComment,
  resolveReportablePost,
  resolveReportableRecruitment,
  resolveReportableSpace,
} from '../server/modules/community/reporting'
import { createSanctionRequest, getSpaceModeration, issueSanction, lookupAuthor, spaceHideItem, spaceUnhideItem } from '../server/modules/community/moderation'
import {
  archiveSpace,
  createBoard,
  createRoom,
  discoverSpaces,
  getSpaceDetail,
  listBoards,
  listMySpaces,
  updateSpace,
} from '../server/modules/community/spaces'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { searchPublic } from '../server/modules/course-hub/search'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createProject } from '../server/modules/projects/projects'
import { createLog } from '../server/modules/logs/logs'
import { createCandidate } from '../server/modules/publication/candidates'
import { getPublicPublication } from '../server/modules/publication/public-read'
import { publishCandidate } from '../server/modules/publication/releases'
import { enableStudyRecord, getStudyRecord } from '../server/modules/community/study-records'
import { createRobotsHandler, robotsTxt } from '../server/modules/security/robots'
import type { ServiceError } from '../server/modules/errors'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, minutes, verifiedAffiliation, withRollback } from './helpers'

const ROOT = resolve(__dirname, '../../..')
const WEB = resolve(__dirname, '..')
const SERVER = join(WEB, 'server')
const WORKER = join(ROOT, 'apps/worker/src')
const BOT = join(ROOT, 'apps/bot/src')
const SCHEMA = join(ROOT, 'packages/db/src/schema.ts')

const listFiles = (dir: string, ext: RegExp): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (name === 'node_modules' || name.startsWith('.')) return []
        return statSync(path).isDirectory() ? listFiles(path, ext) : ext.test(name) ? [path] : []
      })
    : []
const listTs = (dir: string) => listFiles(dir, /\.ts$/)

// ── 커뮤니티 테이블: schema.ts의 커뮤니티 구역에서 읽습니다 ───────────────────

interface TableDecl {
  exportName: string
  sqlName: string
  community: boolean
}

/**
 * schema.ts를 구역(`// ── 제목`) 단위로 나눠 pgTable 선언을 읽습니다. 제목에 "커뮤니티"가 있는 구역의 테이블이 커뮤니티 테이블입니다.
 * C-04(글·댓글·ThreadAlias·공감)가 테이블을 그 구역에 더하면 아래 모든 경계 검사가 자동으로 그 테이블까지 덮습니다.
 */
function schemaTables(): TableDecl[] {
  const text = readFileSync(SCHEMA, 'utf8')
  const out: TableDecl[] = []
  let community = false
  for (const chunk of text.split(/\n(?=\/\/ ── )/)) {
    const header = chunk.split('\n', 1)[0] ?? ''
    if (header.startsWith('// ── ')) community = header.includes('커뮤니티')
    for (const m of chunk.matchAll(/export const (\w+) = pgTable\(\s*'([a-z0-9_]+)'/g)) out.push({ exportName: m[1]!, sqlName: m[2]!, community })
  }
  return out
}

const TABLES = schemaTables()
const COMMUNITY = TABLES.filter((t) => t.community)
const COMMUNITY_SQL = new Set(COMMUNITY.map((t) => t.sqlName))
const COMMUNITY_TABLE_PATTERN = new RegExp(`\\b(${COMMUNITY.flatMap((t) => [t.exportName, t.sqlName]).join('|')})\\b`)

/** 커뮤니티 테이블처럼 보이는 이름(C-04~C-09 예정 이름 포함). 이런 테이블은 반드시 커뮤니티 구역에 있어야 합니다. */
const COMMUNITY_LIKE_SQL = /^(community_|space_|spaces$|boards?$|posts?$|comments?$|thread_aliases$|reactions$|name_mode_|official_page_|recruitments$|archive_transfers$|study_records$|community$)/

// ── 소스 경계 예외(문서화: ADR 0019·0020·0021) ─────────────────────────────

/** 커뮤니티 테이블을 직접 읽어도 되는 파일. */
const TABLE_ALLOWED = [
  /^web\/server\/modules\/community\//,
  /^web\/server\/api\/v1\/community\//,
  /^web\/server\/api\/v1\/operator\/community\//,
  // 운영 안내(T-15): 제한된 방의 방장에게 조치 안내를 보이려고 space_memberships에서 owner 여부만 확인(이름·내용 없음).
  // C-04(ADR 0022): 가린 글·댓글의 당사자(작성자) 여부와 댓글 조치의 글 id만 읽음(제목·본문 없음).
  /^web\/server\/modules\/moderation\/notices\.ts$/,
  // worker: 탈퇴 정리(멤버십·초대·요청·알림 삭제, 승계)와 이름 표시 방식 변경 적용(C-03). 검색 색인·파생 데이터와 무관.
  /^worker\/src\/ops\/purge\.ts$/,
  /^worker\/src\/ops\/name-modes\.ts$/,
  /^worker\/src\/apply-name-modes\.ts$/,
  // A-02(ADR 0039): 앨범 사진의 끝나지 않은 올리기·통과하지 못한 사진 정리와 격리 파일 정리의 주인 확인(키·상태·시각만, 내용·설명·올린 사람 없음).
  /^worker\/src\/ops\/album-photos\.ts$/,
  // A-04(ADR 0041): 라운지 미디어의 지운 글·끝나지 않은 올리기·통과하지 못한 미디어 정리와 격리 파일 정리의 주인 확인(키·상태·시각·글 상태만).
  /^worker\/src\/ops\/post-media\.ts$/,
]

/** 커뮤니티 모듈을 import해도 되는 파일과, 그 파일이 import할 수 있는 커뮤니티 모듈 파일. */
const IMPORT_ALLOWED: Array<{ file: RegExp; targets: RegExp }> = [
  { file: /^web\/server\/api\/v1\/community\//, targets: /./ },
  { file: /^web\/server\/api\/v1\/operator\/community\//, targets: /./ },
  // 신고·운영 조치 어댑터(T-15·ADR 0019): 신고 대상 확인·운영자 상세의 공간 정보·restrict_space 조치.
  { file: /^web\/server\/modules\/moderation\/(operator|targets|actions)\.ts$/, targets: /^(reporting|official)$/ },
  // 서버 미들웨어: 경로 판정·헤더(테이블 없음).
  { file: /^web\/server\/middleware\/0[23]\.[a-z]+\.ts$/, targets: /^http$/ },
  // C-10(ADR 0027): 운영자 커뮤니티 지표 라우트(`/api/v1/operator/metrics/community`)는 집계 모듈 하나만(개수만, 5 미만 가림).
  { file: /^web\/server\/api\/v1\/operator\/metrics\/community\//, targets: /^ops-metrics$/ },
]

/** 공개 읽기·파생 경로: 커뮤니티 모듈을 어떤 형태로도 import하지 않고 커뮤니티 테이블 이름도 쓰지 않습니다. */
const PUBLIC_READ_DIRS = [
  join(SERVER, 'api/v1/public'),
  join(SERVER, 'modules/publication'),
  join(SERVER, 'modules/course-hub'),
  join(SERVER, 'modules/portfolio'),
  join(SERVER, 'modules/analytics'),
  join(SERVER, 'modules/catalog'),
  join(SERVER, 'modules/identity'),
  join(SERVER, 'modules/ops'),
  WORKER,
]

const rel = (file: string) => relative(join(ROOT, 'apps'), file)
const COMMUNITY_IMPORT = /from\s+['"]([^'"]*\/community\/([a-z-]+))['"]/g

describe('C-05 community tables come from the schema section (source)', () => {
  it('finds every C-02/C-03/C-04 community table and requires community-like tables to live in that section', () => {
    expect(COMMUNITY.map((t) => t.sqlName)).toEqual(
      expect.arrayContaining([
        'community_spaces',
        'space_memberships',
        'boards',
        'space_invitations',
        'official_page_requests',
        'name_mode_changes',
        'community_notices',
        // C-04: 글·댓글·스레드 익명 번호·공감도 같은 구역에서 자동으로 읽힘(아래 모든 경계 검사가 덮음)
        'community_posts',
        'community_comments',
        'thread_aliases',
        'community_reactions',
        // C-06: 이용 제한·작성자 확인 기록·제재 요청도 같은 구역(자동으로 덮임)
        'community_sanctions',
        'community_author_lookups',
        'community_sanction_requests',
        // C-07: 모집·지원도 같은 구역(자동으로 덮임)
        'recruitments',
        'recruitment_applications',
        // C-09: 아카이브로 옮기기 요청·동의(커뮤니티 글·댓글을 가리키므로 같은 구역, 자동으로 덮임)
        'archive_transfers',
        'archive_transfer_consents',
        // C-08: 스터디 방 ↔ 내부 과제 연결(커뮤니티 → 과제 방향만, 자동으로 덮임)
        'study_records',
      ]),
    )
    // C-09(ADR 0025): 막힘 Q&A 복사본은 아카이브 쪽(과목 허브 구역) 테이블이고 커뮤니티 테이블을 가리키지 않습니다.
    // 공개 읽기 경로(과목 허브·검색·신호)가 이 테이블만 읽어도 커뮤니티 테이블에 닿을 길이 없게 합니다.
    expect(COMMUNITY_SQL.has('course_qa_items')).toBe(false)
    const qaBlock = readFileSync(SCHEMA, 'utf8').split(/\nexport const /).find((b) => b.startsWith("courseQaItems = pgTable("))!
    expect(qaBlock).toBeTruthy()
    for (const t of COMMUNITY) expect(qaBlock, `course_qa_items → ${t.sqlName}`).not.toMatch(new RegExp(`\\b(${t.exportName}|${t.sqlName})\\b`))
    // 다른 구역에 커뮤니티처럼 보이는 테이블이 있으면 경계 검사에서 빠지므로 실패합니다(C-04: posts·comments는 커뮤니티 구역에).
    const misplaced = TABLES.filter((t) => !t.community && COMMUNITY_LIKE_SQL.test(t.sqlName)).map((t) => t.sqlName)
    expect(misplaced).toEqual([])
    expect(TABLES.length).toBeGreaterThan(50)
  })
})

describe('C-05 module boundary: only the community module reads community tables (source)', () => {
  const files = [...listTs(SERVER), ...listTs(WORKER), ...listTs(BOT)]

  it('no file outside the community module and the documented exceptions names a community table', () => {
    expect(files.length).toBeGreaterThan(150)
    const offenders = files.filter((f) => !TABLE_ALLOWED.some((re) => re.test(rel(f))) && COMMUNITY_TABLE_PATTERN.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('only community routes, the moderation adapters and the middleware import the community module', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (rel(f).startsWith('web/server/modules/community/')) continue
      for (const m of readFileSync(f, 'utf8').matchAll(COMMUNITY_IMPORT)) {
        if (!m[1]!.includes('modules/community/') && !m[1]!.startsWith('../community/') && !m[1]!.startsWith('./community/')) continue
        const ok = IMPORT_ALLOWED.some((a) => a.file.test(rel(f)) && a.targets.test(m[2]!))
        if (!ok) offenders.push(`${rel(f)} → ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('public search, course hub, public profile, portfolio, analytics, publication snapshots and worker derived handlers never touch community code or tables', () => {
    const exempt = TABLE_ALLOWED
    const publicFiles = PUBLIC_READ_DIRS.flatMap(listTs).filter((f) => !exempt.some((re) => re.test(rel(f))))
    expect(publicFiles.length).toBeGreaterThan(40)
    for (const f of publicFiles) {
      const text = readFileSync(f, 'utf8')
      expect(text, rel(f)).not.toMatch(/modules\/community|\.\.\/community\//)
      expect(text, rel(f)).not.toMatch(COMMUNITY_TABLE_PATTERN)
    }
  })

  it('the community module never writes server logs (audit metadata carries ids/codes only, see the DB test)', () => {
    for (const f of listTs(join(SERVER, 'modules/community'))) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/console\.|logger\.|useLogger|consola/)
  })

  it('there is no sitemap; any future sitemap route must not list community paths', () => {
    const candidates = [...listFiles(SERVER, /\.ts$/), ...listFiles(join(WEB, 'app'), /\.(ts|vue)$/), ...listFiles(join(WEB, 'public'), /./)].filter((f) =>
      /sitemap/i.test(relative(WEB, f)),
    )
    for (const f of candidates) {
      const text = readFileSync(f, 'utf8')
      expect(text, relative(WEB, f)).not.toMatch(/\/community|community_spaces|communitySpaces|modules\/community/)
    }
    const pkg = readFileSync(join(WEB, 'package.json'), 'utf8') + readFileSync(join(WEB, 'nuxt.config.ts'), 'utf8')
    expect(pkg).not.toMatch(/sitemap/i)
    // robots.txt에도 Sitemap 줄이 없음
    for (const indexing of ['1', undefined]) expect(robotsTxt({ PEERCHIVE_PUBLIC_INDEXING: indexing })).not.toMatch(/sitemap/i)
  })

  it('community pages build their head only through useCommunityPage (no space-derived title, no OG, no description)', () => {
    const pages = listFiles(join(WEB, 'app/pages/community'), /\.vue$/)
    expect(pages.length).toBeGreaterThanOrEqual(4)
    for (const f of pages) {
      const text = readFileSync(f, 'utf8')
      expect(text, relative(WEB, f)).toContain('useCommunityPage()')
      expect(text, relative(WEB, f)).not.toMatch(/useSeoMeta|useServerSeoMeta|useHead\(|og:|twitter:|defineOgImage/)
    }
    const composable = readFileSync(join(WEB, 'app/composables/useCommunityPage.ts'), 'utf8')
    expect(composable).not.toMatch(/property:|useSeoMeta|ogTitle|ogImage/)
  })

  it('logout drops cached private data (asyncData/state) and reloads the app', () => {
    const auth = readFileSync(join(WEB, 'app/composables/useAuth.ts'), 'utf8')
    expect(auth).toMatch(/clearNuxtData\(\)/)
    expect(auth).toMatch(/reloadNuxtApp\(/)
  })
})

// ── 분석 허용 목록 ─────────────────────────────────────────────────────────

const COMMUNITY_EVENT = /^(space_|name_mode_|post_|comment_|community_|board_|reaction_|thread_|recruitment_|archive_|study_)/
const FORBIDDEN_PROP_KEY = /(id|name|slug|title|body|text|description|content|email|handle|school|board|space|post|comment|url|token)/i

describe('C-05 analytics: community events carry codes only', () => {
  it('community events exist and allow only enum/bool props with code-like keys', () => {
    const events = ANALYTICS_EVENT_NAMES.filter((n) => COMMUNITY_EVENT.test(n))
    expect(events).toEqual(expect.arrayContaining(['space_created', 'space_joined', 'name_mode_scheduled', 'name_mode_applied']))
    for (const name of events) {
      for (const [key, spec] of Object.entries(ANALYTICS_PROP_SPECS[name])) {
        expect(key, `${name}.${key}`).not.toMatch(FORBIDDEN_PROP_KEY)
        expect(['enum', 'bool'], `${name}.${key}`).toContain(spec.kind)
        if (spec.kind === 'enum') for (const v of spec.values) expect(v).toMatch(/^[a-z_]+$/)
      }
      for (const leak of [{ spaceId: crypto.randomUUID() }, { name: '우리 방' }, { slug: 'abcdefghij' }, { text: '본문' }, { kind: '자유 글' }]) {
        expect(sanitizeAnalyticsProps(name, leak).ok, `${name} ${JSON.stringify(leak)}`).toBe(false)
      }
    }
  })
})

// ── HTTP 경계(DB 없이) ─────────────────────────────────────────────────────

const BOT_USER_AGENTS = [
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
  'TelegramBot (like TwitterBot)',
  'kakaotalk-scrap/1.0 (+https://devtalk.kakao.com/)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
]

function guardedApp() {
  const app = createApp()
  // 02.auth 대역: 테스트 헤더가 있으면 로그인한 것으로 봅니다.
  app.use(
    defineEventHandler((event) => {
      event.context.auth = event.headers.get('x-test-user') ? { sessionId: 's', user: { id: event.headers.get('x-test-user')! } as never } : null
    }),
  )
  app.use(createCommunityGuard())
  const router = createRouter()
    .get('/api/v1/community/spaces/:slug', defineEventHandler(() => ({ name: 'SECRET ROOM' })))
    .get('/api/v1/projects', defineEventHandler(() => ({ ok: true })))
    .get('/robots.txt', createRobotsHandler(() => ({})))
    .get('/c/:id', defineEventHandler(() => '<html>course</html>'))
    .get('/community/**', defineEventHandler(() => '<html><title>SECRET ROOM</title></html>'))
    .get('/community', defineEventHandler(() => '<html>community home</html>'))
  app.use(router)
  const handler = toWebHandler(app)
  return (path: string, init: { method?: string; ua?: string; user?: string; cookie?: string } = {}) =>
    handler(
      new Request(`http://localhost:3000${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.ua && { 'user-agent': init.ua }),
          ...(init.user && { 'x-test-user': init.user }),
          ...(init.cookie && { cookie: init.cookie }),
        },
      }),
    )
}

const expectCommunityHeaders = (res: Response) => {
  expect(res.headers.get('x-robots-tag')).toBe(COMMUNITY_ROBOTS)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('set-cookie')).toBeNull()
}

const PAGE_PATHS = ['/community', '/community/', '/community/notices', '/community/s/abcdefghij', '/community/s/zzzzzzzzzz?x=1', '/community/invite/tok3nTOKENtoken1234567', '/community/s/abcdefghij/_payload.json']

describe('C-05 HTTP boundary (no DB)', () => {
  const get = guardedApp()

  it('classifies community paths exactly', () => {
    for (const p of ['/community', '/community/', '/community/s/x', '/community?q=1', '/community#a']) expect(isCommunityPagePath(p), p).toBe(true)
    for (const p of ['/communityx', '/c/1', '/c', '/api/v1/community/x', '/u/community', '/']) expect(isCommunityPagePath(p), p).toBe(false)
    for (const p of ['/api/v1/community', '/api/v1/community/spaces/mine', '/api/v1/community?x']) expect(isCommunityApiPath(p), p).toBe(true)
    for (const p of ['/api/v1/communityx', '/api/v1/operator/community/spaces', '/community']) expect(isCommunityApiPath(p), p).toBe(false)
  })

  it('logged-out page requests get the same fixed 404 HTML for every community URL (no payload, no name, no OG)', async () => {
    for (const path of PAGE_PATHS) {
      const res = await get(path, { cookie: 'peerchive_session=forged' })
      expect(res.status, path).toBe(404)
      expectCommunityHeaders(res)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const body = await res.text()
      expect(body, path).toBe(COMMUNITY_NOT_FOUND_HTML)
    }
    expect(COMMUNITY_NOT_FOUND_HTML).not.toMatch(/og:|twitter:|name="description"|__NUXT|SECRET/)
    expect(COMMUNITY_NOT_FOUND_HTML).toContain(`<meta name="robots" content="${COMMUNITY_ROBOTS}">`)
    expect(COMMUNITY_NOT_FOUND_HTML).toContain(`<title>${COMMUNITY_PAGE_TITLE}</title>`)
    const head = await get('/community/s/abcdefghij', { method: 'HEAD' })
    expect(head.status).toBe(404)
    expect(await head.text()).toBe('')
  })

  it('link unfurlers (Slack, Discord, Facebook, X, Telegram, Kakao, Google) get the identical 404', async () => {
    for (const ua of BOT_USER_AGENTS) {
      const res = await get('/community/s/abcdefghij', { ua })
      expect(res.status, ua).toBe(404)
      expectCommunityHeaders(res)
      expect(await res.text(), ua).toBe(COMMUNITY_NOT_FOUND_HTML)
    }
  })

  it('logged-out API calls get one 401 body for every path (existence is not revealed)', async () => {
    const bodies = new Set<string>()
    for (const path of ['/api/v1/community/spaces/abcdefghij', '/api/v1/community/spaces/zzzzzzzzzz', '/api/v1/community/spaces/mine', '/api/v1/community/nope']) {
      const res = await get(path, { ua: BOT_USER_AGENTS[0] })
      expect(res.status, path).toBe(401)
      expectCommunityHeaders(res)
      const json = (await res.json()) as { data: unknown; url?: string }
      expect(json.data).toEqual({ code: 'unauthenticated' })
      bodies.add(JSON.stringify({ ...json, url: undefined }))
    }
    expect(bodies.size).toBe(1)
  })

  it('logged-in requests pass through to the handler/SSR with the same headers; other paths are untouched', async () => {
    const page = await get('/community/s/abcdefghij', { user: 'u1' })
    expect(page.status).toBe(200)
    expectCommunityHeaders(page)
    const api = await get('/api/v1/community/spaces/abcdefghij', { user: 'u1' })
    expect(api.status).toBe(200)
    expectCommunityHeaders(api)
    for (const path of ['/c/1', '/api/v1/projects']) {
      const res = await get(path)
      expect(res.headers.get('x-robots-tag'), path).toBeNull()
      expect(res.status, path).toBe(200)
    }
  })
})

// ── robots.txt ────────────────────────────────────────────────────────────

/** 구글 방식 robots 판정(가장 긴 규칙, 같으면 Allow, `$` 끝 고정). 테스트용 최소 구현. */
function robotsAllows(txt: string, path: string): boolean {
  let best: { len: number; allow: boolean } | null = null
  for (const line of txt.split('\n')) {
    const m = /^(Allow|Disallow):\s*(\S+)/.exec(line)
    if (!m) continue
    const rule = m[2]!
    const anchored = rule.endsWith('$')
    const prefix = anchored ? rule.slice(0, -1) : rule
    const hit = anchored ? path === prefix : path.startsWith(prefix)
    if (!hit) continue
    const len = rule.length
    const allow = m[1] === 'Allow'
    if (!best || len > best.len || (len === best.len && allow)) best = { len, allow }
  }
  return best ? best.allow : true
}

const COMMUNITY_AND_PRIVATE = [
  '/community',
  '/community/s/abcdefghij',
  '/community/invite/x',
  '/api/v1/community/spaces/abcdefghij',
  '/settings/affiliations',
  '/me/reports',
  '/operator',
  '/operator/community',
  '/projects/1',
  '/portfolio',
  '/consents',
  '/invite/abc',
  '/api/v1/me',
]

describe('C-05 robots.txt', () => {
  it('disallows everything when public indexing is off (pilot default)', () => {
    const txt = robotsTxt({})
    expect(txt).toContain('User-agent: *\nDisallow: /\n')
    for (const p of [...COMMUNITY_AND_PRIVATE, '/p/case', '/c/1', '/u/me', '/search', '/']) expect(robotsAllows(txt, p), p).toBe(false)
    expect(robotsTxt({ PEERCHIVE_PUBLIC_INDEXING: '0' })).toBe(txt)
  })

  it('with indexing on, opens only public pages and keeps community/private paths blocked', () => {
    const txt = robotsTxt({ PEERCHIVE_PUBLIC_INDEXING: '1' })
    for (const line of ['Disallow: /community', 'Disallow: /api/v1/community', 'Disallow: /settings', 'Disallow: /me', 'Disallow: /operator', 'Disallow: /projects', 'Disallow: /portfolio', 'Disallow: /consents']) {
      expect(txt).toContain(`${line}\n`)
    }
    for (const p of COMMUNITY_AND_PRIVATE) expect(robotsAllows(txt, p), p).toBe(false)
    for (const p of ['/p/case-1', '/c/123', '/u/handle', '/search', '/search?q=x', '/api/v1/public/search', '/']) expect(robotsAllows(txt, p), p).toBe(true)
    expect(txt).not.toMatch(/^Allow: \/community/m)
  })

  it('is served as text/plain, no-store, reading the env per request', async () => {
    const env: Record<string, string | undefined> = {}
    const app = createApp().use(createRouter().get('/robots.txt', createRobotsHandler(() => env)))
    const handler = toWebHandler(app)
    const res = await handler(new Request('http://localhost:3000/robots.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe(robotsTxt({}))
    env.PEERCHIVE_PUBLIC_INDEXING = '1'
    expect(await (await handler(new Request('http://localhost:3000/robots.txt'))).text()).toBe(robotsTxt({ PEERCHIVE_PUBLIC_INDEXING: '1' }))
  })
})

// ── DB: 행위자 × 경로 매트릭스, 소개, 센티넬, 감사·분석 ─────────────────────

const T0 = new Date('2026-11-04T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
/** 공간 셋·사람 여럿을 만드는 fixture가 무거워 첫 실행(콜드 캐시)에 5초를 넘을 수 있습니다. */
const DB_TIMEOUT = 60_000

interface World {
  op: { userId: string }
  schoolId: string
  otherSchoolId: string
  owner: { userId: string }
  member: { userId: string }
  sentinel: string
  rooms: { listedLinked: string; unlistedApproval: string; inviteOnly: string; official: string }
  actors: Record<string, { userId: string }>
  memberAffiliationId: string
}

async function student(tx: DbExecutor, schoolId: string): Promise<{ userId: string; affiliationId: string }> {
  const u = await createUser(tx, { handle: `v${rand()}` })
  // 표시명 방에서 쓰려면 표시명 페르소나가 있어야 합니다(ADR 0030).
  await insertDisplayPersona(tx, u.id)
  const a = await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id, affiliationId: a.id }
}

/** 방 셋(학교 연결 listed 자유 가입, 학교 무관 unlisted 승인, 학교 연결 초대 전용) + 공식 페이지, 여러 상태의 사람들. 모든 이름·소개에 센티넬. */
async function world(tx: DbExecutor): Promise<World> {
  const sentinel = `VISSENT${rand()}`
  RECS.clear()
  APPS.clear()
  const op = { userId: (await createUser(tx)).id }
  await tx.insert(operators).values({ userId: op.userId })
  const school = await createSchool(tx, op, { name: `범위대${rand()}학교`, confirmNew: true }, T0)
  const other = await createSchool(tx, op, { name: `남의대${rand()}학교`, confirmNew: true }, T0)
  const owner = await student(tx, school.id)
  const member = await student(tx, school.id)
  const listed = await createRoom(tx, owner, { name: `${sentinel} 열린방`, description: `${sentinel} 열린 소개`, nameMode: 'display', schoolId: school.id, joinPolicy: 'open', discovery: 'listed' }, T0)
  const unlisted = await createRoom(tx, owner, { name: `${sentinel} 숨은방`, description: `${sentinel} 숨은 소개`, nameMode: 'anonymous', joinPolicy: 'approval', discovery: 'unlisted' }, T0)
  const invite = await createRoom(tx, owner, { name: `${sentinel} 초대방`, description: `${sentinel} 초대 소개`, nameMode: 'real', schoolId: school.id, joinPolicy: 'invite', discovery: 'unlisted' }, T0)
  const official = await createOfficialPage(tx, op, { schoolId: school.id, name: `${sentinel} 공식`, description: `${sentinel} 공식 소개` }, T0)
  for (const slug of [listed.slug, unlisted.slug, invite.slug]) await createBoard(tx, owner, slug, { kind: 'free', title: `${sentinel.slice(0, 12)} 판` }, at(1))
  // C-04: 공간마다 센티넬 글·댓글 하나(실명 방은 방장이 실명을 입력한 뒤). 행위자 × 경로 매트릭스가 글 경로도 덮습니다.
  await updateRealName(tx, owner, { realName: '방장실명' })
  for (const detail of [listed, unlisted, invite, official]) {
    const post = await createPost(tx, owner, detail.boards[0]!.id, { title: `${sentinel} 글`, body: `${sentinel} 본문` }, at(1))
    const thread = await createComment(tx, owner, post.id, { body: `${sentinel} 댓글` }, at(1))
    POSTS.set(detail.slug, { boardId: detail.boards[0]!.id, postId: post.id, commentId: thread.comments[0]!.id })
  }
  // C-07: 공간마다 센티넬 스터디 모집 하나(방은 모집 게시판을 더함) + 다른 멤버 지원 하나. 행위자 × 경로 매트릭스가 모집 경로도 덮습니다.
  for (const slug of [listed.slug, unlisted.slug, invite.slug]) await createBoard(tx, owner, slug, { kind: 'recruiting', title: '모집' }, at(1))
  for (const detail of [listed, unlisted, invite, official]) {
    const rec = await createRecruitment(tx, owner, { kind: 'study', spaceSlug: detail.slug, title: `${sentinel} 모집`, description: `${sentinel} 모집 소개`, capacity: 2 }, at(1))
    RECS.set(detail.slug, rec.id)
  }

  await joinSpace(tx, member, listed.slug, at(2))
  for (const slug of [unlisted.slug, invite.slug]) {
    const { token } = await createSpaceInvitation(tx, owner, slug, at(2))
    await acceptSpaceInvitation(tx, member, { token }, at(2))
  }
  // C-07: 멤버가 네 모집 모두에 센티넬 메시지로 지원(지원 메시지 신고 경로도 매트릭스에 들어감)
  for (const [slug, recId] of RECS) APPS.set(slug, (await applyToRecruitment(tx, member, recId, { message: `${sentinel} 지원` }, at(2))).id)
  const removed = await student(tx, school.id)
  const left = await student(tx, school.id)
  const revoked = await student(tx, school.id)
  for (const p of [removed, left, revoked]) {
    await joinSpace(tx, p, listed.slug, at(3))
    for (const slug of [unlisted.slug, invite.slug]) {
      const { token } = await createSpaceInvitation(tx, owner, slug, at(3))
      await acceptSpaceInvitation(tx, p, { token }, at(3))
    }
  }
  for (const slug of [listed.slug, unlisted.slug, invite.slug]) {
    await removeMember(tx, owner, slug, removed.userId, at(4))
    await leaveSpace(tx, left, slug, at(4))
  }
  // 이름 표시 방식 예약(멤버 전원 알림) → 인증 해제 뒤 알림의 공간 이름이 사라지는지
  await scheduleNameModeChange(tx, owner, listed.slug, { toMode: 'anonymous' }, at(5))
  await removeAffiliation(tx, revoked, revoked.affiliationId, at(6))

  const otherSchool = await student(tx, other.id)
  const unverified = { userId: (await createUser(tx, { handle: `n${rand()}` })).id }
  const nonMember = await student(tx, school.id)
  return {
    op,
    schoolId: school.id,
    otherSchoolId: other.id,
    owner,
    member,
    sentinel,
    rooms: { listedLinked: listed.slug, unlistedApproval: unlisted.slug, inviteOnly: invite.slug, official: official.slug },
    actors: { otherSchool, unverified, nonMember, removed, left, revoked },
    memberAffiliationId: member.affiliationId,
  }
}

type Op = (tx: DbExecutor, actor: { userId: string }, slug: string) => Promise<unknown>

/** 공간 slug → 그 공간의 게시판·센티넬 글·댓글(world가 채움, C-04). */
const POSTS = new Map<string, { boardId: string; postId: string; commentId: string }>()
const postOf = (slug: string) => POSTS.get(slug)!
/** 공간 slug → 그 공간의 센티넬 모집 id(C-07). */
const RECS = new Map<string, string>()
const recOf = (slug: string) => RECS.get(slug)!
const APPS = new Map<string, string>()
const appOf = (slug: string) => APPS.get(slug)!

/** 공간 하나를 대상으로 하는 경로 종류(읽기·관리·쓰기). 모두 같은 정책 함수(loadReadableSpace/getSpaceDetail)를 거칩니다. */
const SPACE_OPS: Record<string, Op> = {
  'GET spaces/:slug': (tx, a, s) => getSpaceDetail(tx, a, s, at(10)),
  'GET boards': (tx, a, s) => listBoards(tx, a, s),
  'POST boards': (tx, a, s) => createBoard(tx, a, s, { kind: 'info', title: '정보' }, at(10)),
  'GET members': (tx, a, s) => listMembers(tx, a, s),
  'GET invitations': (tx, a, s) => listSpaceInvitations(tx, a, s, at(10)),
  'POST invitations': (tx, a, s) => createSpaceInvitation(tx, a, s, at(10)),
  'GET name-mode-changes': (tx, a, s) => getNameModeState(tx, a, s, at(10)),
  'POST name-mode-changes': (tx, a, s) => scheduleNameModeChange(tx, a, s, { toMode: 'real' }, at(10)),
  'PATCH spaces/:slug': (tx, a, s) => updateSpace(tx, a, s, { name: '바꾼 이름' }, at(10)),
  'POST archive': (tx, a, s) => archiveSpace(tx, a, s, at(10)),
  'POST reports (community_space)': (tx, a, s) => resolveReportableSpace(tx, a, { spaceSlug: s }),
  // C-04 글·댓글·공감·신고: 같은 정책 함수(loadReadableSpace)를 거쳐 읽을 수 없으면 404
  'GET boards/:id/posts': (tx, a, s) => listBoardPosts(tx, a, postOf(s).boardId, {}, at(10)),
  'POST boards/:id/posts': (tx, a, s) => createPost(tx, a, postOf(s).boardId, { title: '제목', body: '본문' }, at(10)),
  'GET posts/:id': (tx, a, s) => getPost(tx, a, postOf(s).postId, at(10)),
  'PATCH posts/:id': (tx, a, s) => editPost(tx, a, postOf(s).postId, { body: '고침', expectedVersion: 1 }, at(10)),
  'POST posts/:id/comments': (tx, a, s) => createComment(tx, a, postOf(s).postId, { body: '댓글' }, at(10)),
  'PUT posts/:id/reaction': (tx, a, s) => setReaction(tx, a, 'post', postOf(s).postId, true, at(10)),
  'PUT comments/:id/reaction': (tx, a, s) => setReaction(tx, a, 'comment', postOf(s).commentId, true, at(10)),
  'POST reports (community_post)': (tx, a, s) => resolveReportablePost(tx, a, { postId: postOf(s).postId }),
  'POST reports (community_comment)': (tx, a, s) => resolveReportableComment(tx, a, { commentId: postOf(s).commentId }),
  // C-06 방 운영진 도구: 읽을 수 없으면 운영진 여부보다 먼저 404
  'GET spaces/:slug/moderation': (tx, a, s) => getSpaceModeration(tx, a, s, at(10)),
  'POST posts/:id/hide': (tx, a, s) => spaceHideItem(tx, a, 'post', postOf(s).postId, { publicReason: '사유' }, at(10)),
  'POST posts/:id/unhide': (tx, a, s) => spaceUnhideItem(tx, a, 'post', postOf(s).postId, {}, at(10)),
  'POST comments/:id/hide': (tx, a, s) => spaceHideItem(tx, a, 'comment', postOf(s).commentId, { publicReason: '사유' }, at(10)),
  'POST sanction-requests': (tx, a, s) => createSanctionRequest(tx, a, { targetType: 'post', targetId: postOf(s).postId, reason: 'spam', details: '설명' }, at(10)),
  // C-07 모집·지원: 공간을 읽을 수 없으면 모집도 404(공간 읽기 정책을 따름)
  'GET recruitments?space': (tx, a, s) => listRecruitments(tx, a, { space: s }, at(10)),
  'POST recruitments (space)': (tx, a, s) => createRecruitment(tx, a, { kind: 'study', spaceSlug: s, title: '모집', capacity: 2 }, at(10)),
  'GET recruitments/:id': (tx, a, s) => getRecruitment(tx, a, recOf(s), at(10)),
  'POST recruitments/:id/applications': (tx, a, s) => applyToRecruitment(tx, a, recOf(s), { message: '지원' }, at(10)),
  'GET recruitments/:id/applications': (tx, a, s) => listApplications(tx, a, recOf(s), at(10)),
  'POST recruitments/:id/withdraw': (tx, a, s) => withdrawApplication(tx, a, recOf(s), at(10)),
  'POST recruitments/:id/invitation': (tx, a, s) => issueRecruitmentInvitation(tx, a, recOf(s), at(10)),
  'POST reports (community_recruitment)': (tx, a, s) => resolveReportableRecruitment(tx, a, { recruitmentId: recOf(s) }, at(10)),
  'POST reports (community_application)': (tx, a, s) => resolveReportableApplication(tx, a, { applicationId: appOf(s) }, at(10)),
  // C-08 스터디 기록: 공간을 읽을 수 없으면 기록 상태·켜기도 404(과제 쪽 경로의 매트릭스는 study-records.integration.test.ts)
  'GET study-record': (tx, a, s) => getStudyRecord(tx, a, s),
  'POST study-record': (tx, a, s) => enableStudyRecord(tx, a, s, {}, at(10)),
}

describe.skipIf(!databaseUrl)('C-05 visibility matrix and data boundary (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => setAnalyticsEnvForTesting(null))

  it('every non-entitled actor gets 404 on every endpoint class of every space (other school, unverified, non-member, removed, left, revoked)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      // 기대 표: 행위자 → 공간 → 소개(preview)를 받는지. 나머지 칸은 모두 404.
      const previewable: Record<string, string[]> = {
        nonMember: [w.rooms.listedLinked, w.rooms.unlistedApproval],
        left: [w.rooms.listedLinked, w.rooms.unlistedApproval],
        // 다른 학교 사람: 학교 무관 방은 아무 학교 인증으로 소개를 봄(들어올 수 있으므로). 학교 연결 방·공식 페이지는 404.
        otherSchool: [w.rooms.unlistedApproval],
        // 인증 해제: 학교 연결 방·공식 페이지·학교 무관 방 모두 자격 없음(다른 인증이 없음).
        revoked: [],
        unverified: [],
        removed: [],
      }
      // 공식 페이지는 그 학교 active 인증에서 읽기가 나오므로(ADR 0019) 같은 학교 인증이 남아 있는 사람(nonMember·left·removed)은 표에서 뺍니다.
      const sameSchoolActive = new Set(['nonMember', 'left', 'removed'])
      const cells: string[] = []
      for (const [name, actor] of Object.entries(w.actors)) {
        for (const slug of Object.values(w.rooms)) {
          if (slug === w.rooms.official && sameSchoolActive.has(name)) continue
          for (const [label, op] of Object.entries(SPACE_OPS)) {
            const preview = previewable[name]!.includes(slug)
            // 소개를 볼 수 있는 사람은 상세(preview)·신고만 성공하고, 내용·관리 경로는 404입니다.
            if (preview && (label === 'GET spaces/:slug' || label === 'POST reports (community_space)')) continue
            const err = (await op(tx, actor, slug).then(
              () => null,
              (e: unknown) => e,
            )) as ServiceError | null
            if (err?.code !== 'NOT_FOUND') cells.push(`${name} × ${label} × ${slug}: ${err ? `${err.code}/${err.reason}` : 'ok'}`)
          }
        }
      }
      expect(cells).toEqual([])

      // 가입: 자격이 없으면 404(존재를 숨김). 내보내진 사람은 이미 아는 방이라 403 removed(ADR 0019), 초대 전용은 소개조차 없어 404가 아닌
      // 403 invite_only지만 자격 있는 사람에게만 나옴.
      for (const actor of [w.actors.otherSchool!, w.actors.unverified!, w.actors.revoked!]) {
        await expectServiceError(joinSpace(tx, actor, w.rooms.listedLinked, at(11)), 'NOT_FOUND')
        await expectServiceError(joinSpace(tx, actor, w.rooms.inviteOnly, at(11)), 'NOT_FOUND')
      }
      await expectServiceError(joinSpace(tx, w.actors.unverified!, w.rooms.unlistedApproval, at(11)), 'NOT_FOUND')
      // 초대 링크도 자격이 없으면 이름 없이 404
      const { token } = await createSpaceInvitation(tx, w.owner, w.rooms.inviteOnly, at(11))
      for (const actor of [w.actors.otherSchool!, w.actors.unverified!, w.actors.revoked!]) {
        await expectServiceError(previewSpaceInvitation(tx, actor, token, at(11)), 'NOT_FOUND', 'not_eligible')
        await expectServiceError(acceptSpaceInvitation(tx, actor, { token }, at(11)), 'NOT_FOUND')
      }

      // 목록·찾기·알림에도 나오지 않음
      const roomWords = ['열린방', '숨은', '초대방']
      for (const [name, actor] of Object.entries(w.actors)) {
        const mine = await listMySpaces(tx, actor)
        const found = await discoverSpaces(tx, actor, {})
        const notices = await listMyCommunityNotices(tx, actor)
        const sameSchool = sameSchoolActive.has(name)
        // 같은 학교 인증이 있으면 공식 페이지만 내 공간에 보이고(인증 파생), 찾기에는 공식 페이지 + (내보내지지 않았다면) listed 방만
        expect(mine.items.map((s) => s.slug), name).toEqual(sameSchool ? [w.rooms.official] : [])
        expect(mine.pending, name).toEqual([])
        expect(found.map((s) => s.slug).sort(), name).toEqual(
          !sameSchool ? [] : name === 'removed' ? [w.rooms.official] : [w.rooms.listedLinked, w.rooms.official].sort(),
        )
        const text = JSON.stringify({ items: mine.items, notices })
        for (const word of name === 'removed' || !sameSchool ? roomWords : roomWords.slice(1)) expect(JSON.stringify({ mine, found, notices }), `${name} ${word}`).not.toContain(word)
        if (!sameSchool) expect(text, name).not.toContain(w.sentinel)
      }
      // 인증이 해제된 멤버: 알림 행은 남지만 공간 이름·slug 없음
      const revokedNotices = await listMyCommunityNotices(tx, w.actors.revoked!)
      expect(revokedNotices.items.length).toBe(1)
      expect(JSON.stringify(revokedNotices)).not.toContain(w.sentinel)
      expect(JSON.stringify(revokedNotices)).not.toContain(w.rooms.listedLinked)

      // 다시 인증하면 돌아옴(멤버십은 그대로)
      await verifiedAffiliation(tx, w.actors.revoked!.userId, w.schoolId)
      expect(await getSpaceDetail(tx, w.actors.revoked!, w.rooms.listedLinked, at(12))).toMatchObject({ access: 'member' })

      // 멤버도 학교 인증이 해제되면 다음 요청부터 404(학교 연결 방·공식 페이지), 학교 무관 방도 다른 인증이 없으면 404
      expect(await getSpaceDetail(tx, w.member, w.rooms.inviteOnly, at(12))).toMatchObject({ access: 'member' })
      await removeAffiliation(tx, w.member, w.memberAffiliationId, at(13))
      for (const slug of Object.values(w.rooms)) {
        for (const [label, op] of Object.entries(SPACE_OPS)) {
          await expectServiceError(op(tx, w.member, slug), 'NOT_FOUND').catch((e: unknown) => {
            throw new Error(`member after revoke × ${label} × ${slug}: ${String(e)}`)
          })
        }
      }
      // 다른 학교 인증만 있으면 학교 무관 방은 다시 읽음
      await verifiedAffiliation(tx, w.member.userId, w.otherSchoolId)
      expect(await getSpaceDetail(tx, w.member, w.rooms.unlistedApproval, at(14))).toMatchObject({ access: 'member' })
      await expectServiceError(getSpaceDetail(tx, w.member, w.rooms.listedLinked, at(14)), 'NOT_FOUND')
    })
  }, DB_TIMEOUT)

  it('previews: listed rooms show name/description/count only, unlisted rooms hide the description, invite-only rooms show nothing (even to pending requests)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const outsider = w.actors.nonMember!
      const listed = await getSpaceDetail(tx, outsider, w.rooms.listedLinked, at(10))
      expect(listed).toMatchObject({ access: 'preview', boards: [], capacityRequested: null, myMembership: null })
      expect(listed.description).toContain(w.sentinel)
      expect(Object.values(listed.permissions).every((v) => v === false)).toBe(true)
      expect(Object.keys(listed)).not.toEqual(expect.arrayContaining(['members']))
      await expectServiceError(listMembers(tx, outsider, w.rooms.listedLinked), 'NOT_FOUND')

      const unlisted = await getSpaceDetail(tx, outsider, w.rooms.unlistedApproval, at(10))
      expect(unlisted).toMatchObject({ access: 'preview', description: null, boards: [] })
      // 승인 대기: 소개는 보지만 unlisted 방 소개 글은 여전히 없음(목록에서도)
      const pending = await student(tx, w.schoolId)
      expect(await joinSpace(tx, pending, w.rooms.unlistedApproval, at(11))).toMatchObject({ status: 'pending' })
      expect(await getSpaceDetail(tx, pending, w.rooms.unlistedApproval, at(11))).toMatchObject({ access: 'preview', description: null })
      expect((await listMySpaces(tx, pending)).pending).toMatchObject([{ slug: w.rooms.unlistedApproval, description: null }])
      // 멤버는 소개 글을 봄
      expect((await getSpaceDetail(tx, w.member, w.rooms.unlistedApproval, at(11))).description).toContain(w.sentinel)

      // 초대 전용 방: 아무것도 없음. 승인 대기 중에 방이 초대 전용으로 바뀌어도 404(목록에서도 빠짐)
      await expectServiceError(getSpaceDetail(tx, outsider, w.rooms.inviteOnly, at(11)), 'NOT_FOUND')
      await updateSpace(tx, w.owner, w.rooms.unlistedApproval, { joinPolicy: 'invite' }, at(12))
      await expectServiceError(getSpaceDetail(tx, pending, w.rooms.unlistedApproval, at(12)), 'NOT_FOUND')
      expect((await listMySpaces(tx, pending)).pending).toEqual([])
      // 요청 취소(나가기)는 여전히 됨
      expect(await leaveSpace(tx, pending, w.rooms.unlistedApproval, at(13))).toMatchObject({ left: true })
    })
  }, DB_TIMEOUT)

  it('sentinel community content appears in no non-community table and in no public read (search, course hub, publication, profile)', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'visibility-analytics-pepper-for-tests-0123456789' })
      const w = await world(tx)
      // 같은 학교 과목에 게시된 공개 사례(공개 읽기가 비어 있지 않게)
      const author = { userId: (await createUser(tx, { handle: `pub${rand()}` })).id }
      const course = await createCourse(tx, author, w.schoolId, { title: `범위과목${rand()}`, code: `VS-${rand().slice(0, 4)}`, confirmNew: true }, T0)
      const { term } = await createCourseTerm(tx, author, course.id, { year: 2025, semester: 'fall' }, T0)
      const project = await createProject(tx, author, { title: '공개 과제', courseTermId: term.id }, T0)
      const log = (await createLog(tx, author, project.id, { tag: 'progress', body: '파서 완성', links: [] }, at(1))).log
      const slug = `vis-${rand().slice(0, 8)}`
      const candidate = await createCandidate(
        tx,
        author,
        project.id,
        { level: 'summary', title: '공개 사례', summary: '요약', slug, logIds: [log.id], milestoneIds: [], exposure: { [author.userId]: 'name' }, consentSelf: true },
        at(2),
        ORIGINS,
      )
      await publishCandidate(tx, author, candidate.id, { manifestHash: candidate.manifestHash }, at(3))

      // 1) 커뮤니티 테이블 밖 모든 테이블(감사·outbox·분석·검색 문서·공개 스냅샷·포트폴리오·알림 포함)에 센티넬 0건.
      const tables = (await tx.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      )) as unknown as Array<{ table_name: string }>
      const nonCommunity = tables.map((t) => t.table_name).filter((t) => !COMMUNITY_SQL.has(t))
      expect(nonCommunity).toEqual(expect.arrayContaining(['search_documents', 'audit_events', 'outbox_events', 'analytics_events', 'publication_candidates']))
      const leaks: string[] = []
      for (const t of nonCommunity) {
        const [row] = (await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)} x where x::text like ${`%${w.sentinel}%`}`)) as unknown as Array<{ n: number }>
        if (row!.n > 0) leaks.push(`${t}: ${row!.n}`)
      }
      expect(leaks).toEqual([])
      // 센티넬이 실제로 커뮤니티 테이블에는 있음(검사가 헛돌지 않음)
      const [inside] = (await tx.execute(sql`select count(*)::int as n from community_spaces x where x::text like ${`%${w.sentinel}%`}`)) as unknown as Array<{ n: number }>
      expect(inside!.n).toBe(4)

      // 2) 공개 조회 응답
      for (const type of [undefined, 'case', 'stuck', 'note']) {
        const result = await searchPublic(tx, { q: w.sentinel, ...(type && { type }) }, at(20))
        expect(result.results).toEqual([])
      }
      const everything = JSON.stringify([
        await searchPublic(tx, { q: '공개' }, at(20)),
        await getPublicCourseHub(tx, course.id, at(20)),
        await getPublicPublication(tx, slug, at(20)),
      ])
      expect(everything).toContain('공개 사례')
      expect(everything).not.toContain(w.sentinel)
      for (const slugValue of Object.values(w.rooms)) expect(everything).not.toContain(slugValue)
      // 공개 프로필: 방장·멤버의 프로필에 방 이름·소개·slug·커뮤니티 활동이 없음
      for (const person of [w.owner, w.member]) {
        const [p] = (await tx.execute(sql`select handle from profiles where user_id = ${person.userId}`)) as unknown as Array<{ handle: string }>
        const profile = JSON.stringify(await getPublicPortfolioProfile(tx, p!.handle, at(20)))
        expect(profile).not.toContain(w.sentinel)
        for (const slugValue of Object.values(w.rooms)) expect(profile).not.toContain(slugValue)
      }
    })
  }, DB_TIMEOUT)

  it('community audit records and analytics events carry ids, codes, counts and booleans only', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'visibility-analytics-pepper-for-tests-0123456789' })
      const w = await world(tx)
      await updateSpace(tx, w.owner, w.rooms.listedLinked, { name: `${w.sentinel} 새이름`, description: `${w.sentinel} 새소개` }, at(20))
      // C-06: 방 운영진 가리기·되돌리기·제재 요청·작성자 확인·제재 발급도 감사는 id·코드만(사유·설명·메모 글은 감사에 없음)
      const target = postOf(w.rooms.listedLinked)
      await spaceHideItem(tx, w.owner, 'comment', target.commentId, { publicReason: `${w.sentinel} 사유`, note: `${w.sentinel} 메모` }, at(20))
      await spaceUnhideItem(tx, w.owner, 'comment', target.commentId, { note: `${w.sentinel} 되돌림` }, at(20))
      const req = await createSanctionRequest(tx, w.owner, { targetType: 'post', targetId: target.postId, reason: 'spam', details: `${w.sentinel} 설명` }, at(20))
      const lookup = await lookupAuthor(tx, w.op, { targetType: 'post', targetId: target.postId, reason: `${w.sentinel} 확인 사유`, requestId: req.id }, at(20))
      await issueSanction(tx, w.op, { lookupId: lookup.lookupId, level: 'warning', scope: 'space', note: `${w.sentinel} 내부`, publicReason: `${w.sentinel} 공개` }, at(20))
      await archiveSpace(tx, w.owner, w.rooms.inviteOnly, at(21))
      // 이 트랜잭션에서 남긴 행만(audit_events.at 기본값 now()는 트랜잭션 시작 시각).
      const mine = await tx
        .select()
        .from(auditEvents)
        .where(and(sql`${auditEvents.action} like 'community.%'`, sql`${auditEvents.at} >= now()`))
      expect(mine.length).toBeGreaterThan(10)
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      const CODE = /^[a-z_]+$/
      const bad: string[] = []
      for (const r of mine) {
        const text = JSON.stringify(r)
        if (text.includes(w.sentinel)) bad.push(`${r.action}: sentinel`)
        for (const [key, value] of Object.entries((r.metadata ?? {}) as Record<string, unknown>)) {
          // 운영자가 직접 쓰는 조치 사유(note)는 공간 내용이 아니라 운영 기록입니다(ADR 0019). 여기서는 쓰지 않으므로 없어야 합니다.
          const ok =
            value === null ||
            typeof value === 'boolean' ||
            typeof value === 'number' ||
            (typeof value === 'string' && (UUID.test(value) || CODE.test(value)))
          if (!ok) bad.push(`${r.action}.${key}=${JSON.stringify(value)}`)
        }
      }
      expect(bad).toEqual([])

      const events = await tx
        .select()
        .from(analyticsEvents)
        .where(inArray(analyticsEvents.name, ['space_created', 'space_joined', 'name_mode_scheduled', 'name_mode_applied']))
      const recent = events.filter((e) => e.occurredAt >= T0)
      expect(recent.length).toBeGreaterThan(3)
      for (const e of recent) {
        expect(e.projectHash).toBeNull()
        expect(JSON.stringify(e.props)).not.toContain(w.sentinel)
        for (const value of Object.values(e.props as Record<string, unknown>)) expect(typeof value === 'boolean' || (typeof value === 'string' && CODE.test(value))).toBe(true)
      }
    })
  }, DB_TIMEOUT)
})
