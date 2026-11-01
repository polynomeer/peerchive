/**
 * 삭제 장부 재적용 명령(T-16, ADR 0016, docs/ops/RUNBOOK.md "복구 순서").
 *
 *   pnpm ops:reapply-deletions [--ledger-file=<path>] [--dry-run]
 *
 * 대상은 DATABASE_URL(복구한 DB)과 PEERCHIVE_STORAGE_*(복구한 저장소)입니다. `--ledger-file`을 주면 그 장부(지금 운영 DB에서
 * `pnpm ops:export-ledger`로 내보낸 파일, 또는 백업의 ledger.jsonl)를 쓰고 대상 장부에 없는 항목을 넣습니다. 없으면 대상 DB 자신의 장부를 씁니다.
 * 삭제 pepper(PEERCHIVE_DELETION_PEPPER)는 장부를 만든 운영 환경과 같아야 합니다.
 * 출력에는 개수만 남깁니다(이름·이메일·id 없음). 실패하면 종료 코드 1. 이 명령이 끝나기 전에는 PEERCHIVE_MAINTENANCE를 풀지 마세요.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, isProductionMode } from '@peerchive/db'
import { resolveObjectStorage } from '@peerchive/files'
import { loadOpsConfig } from './ops/config'
import { readLedgerFile, reapplyDeletions } from './ops/ledger'

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const ledgerArg = args.find((a) => a.startsWith('--ledger-file='))
const unknown = args.filter((a) => a !== '--dry-run' && !a.startsWith('--ledger-file=') && a !== '--')
if (unknown.length) {
  console.error('usage: reapply-deletions [--ledger-file=<path>] [--dry-run]')
  process.exit(2)
}

const url = process.env.DATABASE_URL?.trim() || process.env.NUXT_DATABASE_URL?.trim()
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(2)
}
const config = loadOpsConfig(process.env)
const storage = resolveObjectStorage(process.env, { production: isProductionMode(process.env) })
const db = createDb(url, { max: 2 })
const started = performance.now()
try {
  // pnpm은 패키지 디렉터리에서 실행하므로 상대 경로는 명령을 친 위치(INIT_CWD) 기준으로 풉니다.
  const entries = ledgerArg ? await readLedgerFile(path.resolve(process.env.INIT_CWD ?? process.cwd(), ledgerArg.slice('--ledger-file='.length))) : undefined
  const result = await reapplyDeletions(db, { storage, deletionPepper: config.deletionPepper, analyticsPepper: config.analyticsPepper }, { entries, dryRun })
  const kinds = Object.entries(result.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}=${n}`)
    .join(' ')
  console.info(
    `[reapply-deletions] ${dryRun ? 'dry-run ' : ''}source=${ledgerArg ? 'file' : 'database'} subjects=${result.subjects} matched=${result.matched} repurged=${result.repurged} imported=${result.imported} certificateFiles=${result.retentionRepurged} ms=${Math.round(performance.now() - started)}${kinds ? ` ${kinds}` : ''}`,
  )
} catch (error) {
  console.error(`[reapply-deletions] failed: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await db.$client.end({ timeout: 5 })
}
