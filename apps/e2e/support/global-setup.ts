/**
 * E2E global setup.
 *
 * 1. 전용 DB(`peerchive_e2e`)를 지우고 다시 만든 뒤 migration을 적용합니다(남은 개발 데이터와 무관하게 시작).
 * 2. 빌드한 web 서버(`apps/web/.output/server/index.mjs`)를 NODE_ENV=development, dev-console 메일,
 *    임시 디렉터리의 filesystem 저장소로 띄웁니다. 서버 stdout은 `.e2e-state/web.log`에 쌓이고, 테스트는
 *    여기서 로그인 링크(`/auth/verify#token=…`)를 읽습니다(ADR 0006의 dev-console transport).
 * 3. worker(signature-only 검사기)를 같은 DB·저장소로 띄웁니다(파일 검사·공개 이벤트).
 *
 * 띄운 프로세스의 PID와 임시 디렉터리는 `.e2e-state/state.json`에 적고 global teardown이 그것만 정리합니다.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import {
  E2E_DB_NAME,
  E2E_PORT,
  REPO_ROOT,
  SERVER_LOG,
  SITE_ORIGIN,
  STATE_DIR,
  STATE_FILE,
  WEB_ENTRY,
  WORKER_LOG,
  e2eDatabaseUrl,
} from './env'
import globalTeardown from './global-teardown'

export interface E2eState {
  webPid: number | null
  workerPid: number | null
  storageRoot: string
}

async function recreateDatabase(url: string): Promise<void> {
  const target = new URL(url)
  const name = decodeURIComponent(target.pathname.slice(1))
  if (!name.endsWith('_e2e')) throw new Error(`E2E DB 이름은 _e2e로 끝나야 합니다(받은 이름: ${name})`)
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`)
    await sql.unsafe(`create database "${name}"`)
  } finally {
    await sql.end()
  }
}

function migrate(url: string): void {
  execFileSync('pnpm', ['--filter', '@peerchive/db', 'migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

async function waitForHealth(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`web 서버가 시작하지 못했습니다(exit ${child.exitCode}). ${SERVER_LOG}를 보세요.`)
    try {
      const res = await fetch(`http://127.0.0.1:${E2E_PORT}/api/v1/health`)
      if (res.ok) {
        const body = (await res.json()) as { db?: { status?: string } }
        if (body.db?.status === 'ok') return
      }
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`web 서버가 ${timeoutMs}ms 안에 응답하지 않았습니다. ${SERVER_LOG}를 보세요.`)
}

async function portInUse(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${E2E_PORT}/`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

export default async function globalSetup(): Promise<void> {
  try {
    await start()
  } catch (error) {
    // 띄운 프로세스가 남지 않게 정리하고 실패를 그대로 알립니다.
    await globalTeardown()
    throw error
  }
}

async function start(): Promise<void> {
  if (!existsSync(WEB_ENTRY)) {
    throw new Error(`빌드 산출물이 없습니다: ${WEB_ENTRY}\n먼저 \`pnpm --filter web build\`를 실행하세요(apps/e2e/README.md).`)
  }
  if (await portInUse()) throw new Error(`포트 ${E2E_PORT}가 이미 쓰이고 있습니다. PEERCHIVE_E2E_PORT로 바꾸세요.`)

  const databaseUrl = e2eDatabaseUrl()
  await recreateDatabase(databaseUrl)
  migrate(databaseUrl)

  rmSync(STATE_DIR, { recursive: true, force: true })
  mkdirSync(STATE_DIR, { recursive: true })
  const storageRoot = mkdtempSync(join(tmpdir(), 'peerchive-e2e-objects-'))

  const shared: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    NUXT_DATABASE_URL: databaseUrl,
    PEERCHIVE_STORAGE_DRIVER: 'filesystem',
    PEERCHIVE_STORAGE_ROOT: storageRoot,
    PEERCHIVE_MALWARE_SCANNER: 'signature-only',
  }
  // 로컬 .env의 메일·내부 API 설정이 섞이지 않게 명시합니다.
  delete shared.PEERCHIVE_MAIL_TRANSPORT
  delete shared.PEERCHIVE_INTERNAL_SECRET
  delete shared.PEERCHIVE_MAINTENANCE
  delete shared.PEERCHIVE_PUBLIC_READS_DISABLED
  // worker가 사이트 origin을 모르면 소셜 링크 되돌림 확인(S-06)을 건너뜁니다: E2E는 바깥 인터넷에 접속하지 않습니다(web에만 따로 넣음).
  delete shared.NUXT_SITE_ORIGIN

  const state: E2eState = { webPid: null, workerPid: null, storageRoot }
  const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  save()

  const webOut = openSync(SERVER_LOG, 'a')
  const web = spawn(process.execPath, [WEB_ENTRY], {
    cwd: STATE_DIR,
    env: {
      ...shared,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(E2E_PORT),
      PORT: String(E2E_PORT),
      NUXT_SITE_ORIGIN: SITE_ORIGIN,
      NUXT_MAIL_TRANSPORT: 'dev-console',
    },
    stdio: ['ignore', webOut, webOut],
    detached: true,
  })
  state.webPid = web.pid ?? null
  save()

  const workerOut = openSync(WORKER_LOG, 'a')
  const worker = spawn(join(REPO_ROOT, 'apps/worker/node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: join(REPO_ROOT, 'apps/worker'),
    env: shared,
    stdio: ['ignore', workerOut, workerOut],
    detached: true,
  })
  state.workerPid = worker.pid ?? null
  save()

  await waitForHealth(web, 30_000)
  if (worker.exitCode !== null) throw new Error(`worker가 시작하지 못했습니다. ${WORKER_LOG}를 보세요.`)

  process.env.PEERCHIVE_E2E_DATABASE_URL = databaseUrl
  process.env.PEERCHIVE_E2E_DB_NAME = E2E_DB_NAME
}
