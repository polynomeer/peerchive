/**
 * worker 설정. 웹앱과 같은 환경 변수(DATABASE_URL, PEERCHIVE_STORAGE_*, PEERCHIVE_S3_*, PEERCHIVE_MALWARE_SCANNER, CLAMAV_*)를 읽습니다.
 *
 * production 판단: NODE_ENV가 development 또는 test가 아니면 production으로 봅니다(배포 때 빠뜨려도 안전한 쪽).
 * production에서는 개발용 검사기(signature-only), 허용 표시 없는 filesystem 저장소, 설정이 빠졌거나 http endpoint인 s3 저장소로
 * 시작하지 않습니다(ADR 0007·0017).
 */
import {
  type Env,
  type MalwareScanner,
  type ObjectStorage,
  resolveMalwareScanner,
  resolveObjectStorage,
} from '@peerchive/files'

export interface WorkerConfig {
  databaseUrl: string
  production: boolean
  storage: ObjectStorage
  scanner: MalwareScanner
  /** 동시에 처리할 검사 작업 수. 파일당 최대 20MB를 메모리에 올리므로 작게 둡니다. */
  scanConcurrency: number
  /** outbox 전달 주기(ms). */
  dispatchIntervalMs: number
}

export function isProductionEnv(env: Env): boolean {
  const mode = env.NODE_ENV?.trim()
  return mode !== 'development' && mode !== 'test'
}

export function loadWorkerConfig(env: Env, cwd = process.cwd()): WorkerConfig {
  const databaseUrl = env.DATABASE_URL?.trim() || env.NUXT_DATABASE_URL?.trim() || ''
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')
  const production = isProductionEnv(env)
  const concurrency = Number(env.PEERCHIVE_SCAN_CONCURRENCY?.trim() || '2')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('PEERCHIVE_SCAN_CONCURRENCY must be 1–8')
  return {
    databaseUrl,
    production,
    storage: resolveObjectStorage(env, { production, cwd }),
    scanner: resolveMalwareScanner(env, { production }),
    scanConcurrency: concurrency,
    dispatchIntervalMs: 2000,
  }
}
