/**
 * 삭제 장부 내보내기(T-16, ADR 0016). 복구 전에 지금 운영 DB의 최신 장부를 파일로 남깁니다(재적용 `--ledger-file`에 씀).
 *
 *   pnpm ops:export-ledger --out=<path>
 *
 * 파일에는 HMAC(subject_hash)·종류·개수·시각만 있습니다(개인정보 없음). 이미 있는 파일은 덮어쓰지 않습니다.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDb } from '@peerchive/db'
import { exportLedger, formatLedgerLines } from './ops/ledger'

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const out = process.argv.slice(2).find((a) => a.startsWith('--out='))?.slice('--out='.length)
if (!out) {
  console.error('usage: export-ledger --out=<path>')
  process.exit(2)
}
const url = process.env.DATABASE_URL?.trim() || process.env.NUXT_DATABASE_URL?.trim()
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(2)
}
const db = createDb(url, { max: 1 })
try {
  const entries = await exportLedger(db)
  // pnpm은 패키지 디렉터리에서 실행하므로 상대 경로는 명령을 친 위치(INIT_CWD) 기준으로 풉니다.
  await writeFile(path.resolve(process.env.INIT_CWD ?? process.cwd(), out), formatLedgerLines(entries), { flag: 'wx', mode: 0o600 })
  console.info(`[export-ledger] entries=${entries.length}`)
} catch (error) {
  console.error(`[export-ledger] failed: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await db.$client.end({ timeout: 5 })
}
