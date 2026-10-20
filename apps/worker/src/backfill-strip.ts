/**
 * 일회성 명령: 메타데이터 제거 backfill(ADR 0007 "메타데이터 제거"). 이 기능 전에 clean이 된 이미지의 메타데이터를 지우고,
 * PDF의 문서 속성 점검 결과를 기록합니다. 몇 번 실행해도 같은 결과입니다(이미 처리한 버전은 건너뜀).
 *
 * 실행: `pnpm --filter worker backfill-strip [--dry-run] [--batch=100]`
 * - 웹·worker와 같은 DATABASE_URL·PEERCHIVE_STORAGE_*를 읽습니다(루트 .env가 있으면 읽음). 검사기는 쓰지 않습니다.
 * - 처리 전 이미지는 공개 후보(422 `metadata_not_stripped`)·공개 조회(404)에서 빠져 있다가, 처리되면 바로 쓸 수 있습니다.
 * - 실패한 버전이 있으면 종료 코드 1. 로그에는 버전 id와 결과 코드만 남깁니다.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDb } from '@peerchive/db'
import { backfillMetadataStrip, resolveObjectStorage } from '@peerchive/files'
import { isProductionEnv } from './config'

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const batchArg = args.find((a) => a.startsWith('--batch='))
const batch = batchArg ? Number(batchArg.slice('--batch='.length)) : 100
if (!Number.isInteger(batch) || batch < 1 || batch > 1000) throw new Error('--batch must be 1–1000')

const databaseUrl = process.env.DATABASE_URL?.trim() || process.env.NUXT_DATABASE_URL?.trim() || ''
if (!databaseUrl) throw new Error('DATABASE_URL is not set')
const storage = resolveObjectStorage(process.env, { production: isProductionEnv(process.env) })
const db = createDb(databaseUrl, { max: 2 })

try {
  const { outcomes } = await backfillMetadataStrip(db, storage, {
    dryRun,
    batch,
    onOutcome: (o) => console.info(`[backfill-strip] ${o.versionId}: ${o.status}${o.status === 'failed' ? ` reason=${o.reason}` : ''}`),
  })
  const counts = new Map<string, number>()
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1)
  const summary = [...counts].map(([status, n]) => `${status}=${n}`).join(' ') || 'nothing to do'
  console.info(`[backfill-strip] ${dryRun ? '(dry run) ' : ''}${summary}`)
  if (counts.get('failed')) process.exitCode = 1
} finally {
  await db.$client.end({ timeout: 5 })
}
