/**
 * E2E 실행 설정. playwright.config.ts·global setup·테스트가 같은 값을 쓰도록 한곳에 둡니다.
 *
 * - DB: `PEERCHIVE_E2E_DATABASE_URL`(있으면 그대로) 또는 `DATABASE_URL`의 DB 이름만 `peerchive_e2e`로 바꾼 주소.
 *   둘 다 없으면 로컬 compose 기본값(127.0.0.1:5432). 이름이 `_e2e`로 끝나지 않는 DB는 지우지 않습니다.
 * - 포트: `PEERCHIVE_E2E_PORT`(기본 3417). 사이트 origin은 `http://localhost:<port>`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const E2E_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
export const STATE_DIR = fileURLToPath(new URL('../.e2e-state/', import.meta.url))
export const STATE_FILE = `${STATE_DIR}state.json`
export const SERVER_LOG = `${STATE_DIR}web.log`
export const WORKER_LOG = `${STATE_DIR}worker.log`
export const WEB_ENTRY = fileURLToPath(new URL('../../web/.output/server/index.mjs', import.meta.url))

export const E2E_DB_NAME = 'peerchive_e2e'

function rootEnvDatabaseUrl(): string | undefined {
  // 저장소 루트 .env(로컬 전용)의 DATABASE_URL을 참고만 합니다(다른 값은 읽지 않음).
  const file = `${REPO_ROOT}.env`
  if (!existsSync(file)) return undefined
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATABASE_URL='))
  return line?.slice('DATABASE_URL='.length).trim() || undefined
}

export function e2eDatabaseUrl(): string {
  const explicit = process.env.PEERCHIVE_E2E_DATABASE_URL?.trim()
  if (explicit) return explicit
  const base = process.env.DATABASE_URL?.trim() || rootEnvDatabaseUrl() || 'postgres://peerchive:peerchive@127.0.0.1:5432/peerchive'
  const url = new URL(base)
  url.pathname = `/${E2E_DB_NAME}`
  return url.toString()
}

export const E2E_PORT = Number(process.env.PEERCHIVE_E2E_PORT || 3417)
export const SITE_ORIGIN = `http://localhost:${E2E_PORT}`
