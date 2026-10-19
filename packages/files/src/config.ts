/**
 * 저장소·검사기 설정(web과 worker가 같은 환경 변수를 읽습니다, ADR 0007).
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_STORAGE_DRIVER | filesystem | 지금은 filesystem만 있음 |
 * | PEERCHIVE_STORAGE_ROOT | .data/objects | 상대 경로면 워크스페이스 루트 기준 |
 * | PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION | (없음) | `1`이면 production에서도 filesystem 허용(단일 서버 pilot) |
 * | PEERCHIVE_MALWARE_SCANNER | signature-only | `clamav` 또는 `signature-only`(개발 전용) |
 * | CLAMAV_HOST / CLAMAV_PORT | 127.0.0.1 / 3310 | clamd 주소 |
 *
 * production에서 filesystem(허용 표시 없음)이나 signature-only를 고르면 예외를 던져 프로세스가 시작되지 않습니다
 * (메일 transport와 같은 방식, ADR 0006).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createFilesystemStorage } from './fs-storage'
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
  throw new Error(`Unknown storage driver: ${driver}`)
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
