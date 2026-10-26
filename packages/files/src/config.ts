/**
 * 저장소·검사기 설정(web과 worker가 같은 환경 변수를 읽습니다, ADR 0007).
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_STORAGE_DRIVER | filesystem | `filesystem` 또는 `s3`(S3 호환, ADR 0017) |
 * | PEERCHIVE_STORAGE_ROOT | .data/objects | filesystem: 상대 경로면 워크스페이스 루트 기준 |
 * | PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION | (없음) | `1`이면 production에서도 filesystem 허용(단일 서버 pilot) |
 * | PEERCHIVE_S3_ENDPOINT | (AWS 기본) | s3: `https://…`(R2·MinIO 등은 필수). production은 https만 |
 * | PEERCHIVE_S3_REGION | (필수) | s3: 예 `ap-northeast-2`, R2는 `auto` |
 * | PEERCHIVE_S3_BUCKET | (필수) | s3: 비공개 버킷 이름 |
 * | PEERCHIVE_S3_ACCESS_KEY_ID / PEERCHIVE_S3_SECRET_ACCESS_KEY | (필수) | s3: 이 버킷만 다루는 키(비밀 저장소에서 주입) |
 * | PEERCHIVE_S3_FORCE_PATH_STYLE | (없음) | s3: `1`이면 경로 방식(MinIO) |
 * | PEERCHIVE_S3_PREFIX | (없음) | s3: 버킷 안의 접두어(예 `peerchive/`) |
 * | PEERCHIVE_MALWARE_SCANNER | signature-only | `clamav` 또는 `signature-only`(개발 전용) |
 * | CLAMAV_HOST / CLAMAV_PORT | 127.0.0.1 / 3310 | clamd 주소 |
 *
 * production에서 filesystem(허용 표시 없음)이나 signature-only, 설정이 빠졌거나 http endpoint인 s3를 고르면 예외를 던져
 * 프로세스가 시작되지 않습니다(메일 transport와 같은 방식, ADR 0006·0017).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createFilesystemStorage } from './fs-storage'
import { type S3StorageConfig, createS3Storage } from './s3-storage'
import { type MalwareScanner, createClamdScanner, createSignatureOnlyScanner } from './scanner'
import type { ObjectStorage } from './storage'

export type Env = Record<string, string | undefined>

/** cwd에서 위로 올라가며 pnpm-workspace.yaml이 있는 디렉터리를 찾습니다. 없으면 cwd. */
export function findWorkspaceRoot(cwd: string): string {
  let dir = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd)
    dir = parent
  }
}

export function resolveStorageRoot(value: string | undefined, cwd: string): string {
  const configured = value?.trim() || '.data/objects'
  return path.isAbsolute(configured) ? configured : path.resolve(findWorkspaceRoot(cwd), configured)
}

export function resolveObjectStorage(env: Env, options: { production: boolean; cwd?: string }): ObjectStorage {
  const driver = env.PEERCHIVE_STORAGE_DRIVER?.trim() || 'filesystem'
  if (driver === 'filesystem') {
    if (options.production && env.PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION !== '1') {
      throw new Error(
        'Storage driver "filesystem" is not allowed in production. Configure an object storage driver, or set PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION=1 for a single-server pilot.',
      )
    }
    return createFilesystemStorage(resolveStorageRoot(env.PEERCHIVE_STORAGE_ROOT, options.cwd ?? process.cwd()))
  }
  if (driver === 's3') return createS3Storage(parseS3StorageConfig(env, options))
  throw new Error(`Unknown storage driver: ${/^[a-z0-9-]{1,32}$/.test(driver) ? driver : '(invalid value)'}`)
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const PREFIX_PATTERN = /^([a-z0-9][a-z0-9._-]*\/)*$/

/**
 * S3 호환 저장소 설정을 읽고 검사합니다(네트워크 접속 없음, 접속 확인은 /api/v1/health?deep=1).
 * 오류 메시지에는 변수 이름만 넣고 값(특히 키)은 넣지 않습니다.
 */
export function parseS3StorageConfig(env: Env, options: { production: boolean }): S3StorageConfig {
  const value = (name: string) => env[name]?.trim() || ''
  const missing = ['PEERCHIVE_S3_REGION', 'PEERCHIVE_S3_BUCKET', 'PEERCHIVE_S3_ACCESS_KEY_ID', 'PEERCHIVE_S3_SECRET_ACCESS_KEY'].filter(
    (name) => !value(name),
  )
  if (missing.length > 0) throw new Error(`S3 storage is not configured: set ${missing.join(', ')}`)

  const region = value('PEERCHIVE_S3_REGION')
  if (!REGION_PATTERN.test(region)) throw new Error('PEERCHIVE_S3_REGION is invalid')
  const bucket = value('PEERCHIVE_S3_BUCKET')
  if (!BUCKET_PATTERN.test(bucket) || bucket.includes('..')) throw new Error('PEERCHIVE_S3_BUCKET is invalid')

  let endpoint: string | undefined
  const rawEndpoint = value('PEERCHIVE_S3_ENDPOINT')
  if (rawEndpoint) {
    let url: URL
    try {
      url = new URL(rawEndpoint)
    } catch {
      throw new Error('PEERCHIVE_S3_ENDPOINT is not a valid URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PEERCHIVE_S3_ENDPOINT must be http(s)')
    // 접속 정보·경로·쿼리를 endpoint에 섞지 않습니다(키는 전용 변수로만).
    if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      throw new Error('PEERCHIVE_S3_ENDPOINT must be an origin only (no credentials, path or query)')
    }
    if (options.production && url.protocol !== 'https:') {
      throw new Error('PEERCHIVE_S3_ENDPOINT must use https in production')
    }
    endpoint = url.origin
  }

  const pathStyle = value('PEERCHIVE_S3_FORCE_PATH_STYLE')
  if (pathStyle && pathStyle !== '1' && pathStyle !== '0') throw new Error('PEERCHIVE_S3_FORCE_PATH_STYLE must be 1 or 0')

  let prefix = value('PEERCHIVE_S3_PREFIX').replace(/^\/+/, '')
  if (prefix && !prefix.endsWith('/')) prefix += '/'
  if (!PREFIX_PATTERN.test(prefix) || prefix.includes('..')) throw new Error('PEERCHIVE_S3_PREFIX is invalid')

  return {
    ...(endpoint && { endpoint }),
    region,
    bucket,
    accessKeyId: value('PEERCHIVE_S3_ACCESS_KEY_ID'),
    secretAccessKey: value('PEERCHIVE_S3_SECRET_ACCESS_KEY'),
    forcePathStyle: pathStyle === '1',
    prefix,
  }
}

export function resolveMalwareScanner(env: Env, options: { production: boolean }): MalwareScanner {
  const name = env.PEERCHIVE_MALWARE_SCANNER?.trim() || 'signature-only'
  if (name === 'signature-only') {
    if (options.production) {
      throw new Error(
        'Malware scanner "signature-only" is not allowed in production. Set PEERCHIVE_MALWARE_SCANNER=clamav and CLAMAV_HOST/CLAMAV_PORT.',
      )
    }
    return createSignatureOnlyScanner()
  }
  if (name === 'clamav') {
    const port = Number(env.CLAMAV_PORT?.trim() || '3310')
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('CLAMAV_PORT is invalid')
    return createClamdScanner({ host: env.CLAMAV_HOST?.trim() || '127.0.0.1', port })
  }
  throw new Error(`Unknown malware scanner: ${name}`)
}
