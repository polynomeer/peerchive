import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isProductionEnv, loadWorkerConfig } from '../src/config'
import { SCAN_QUEUE_OPTIONS, handleScanJob } from '../src/scan-worker'

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'peerchive-worker-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('worker configuration', () => {
  const base = () => ({ DATABASE_URL: 'postgres://x@localhost/db', PEERCHIVE_STORAGE_ROOT: root })

  it('treats anything but development/test as production', () => {
    expect(isProductionEnv({})).toBe(true)
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionEnv({ NODE_ENV: 'staging' })).toBe(true)
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false)
    expect(isProductionEnv({ NODE_ENV: 'test' })).toBe(false)
  })

  it('starts in development with filesystem storage and the signature-only scanner', () => {
    const config = loadWorkerConfig({ ...base(), NODE_ENV: 'development' })
    expect(config).toMatchObject({ production: false, scanConcurrency: 2 })
    expect(config.storage.driver).toBe('filesystem')
    expect(config.scanner.engine).toBe('signature-only')
  })

  it('refuses to start in production without a real scanner or with unapproved filesystem storage', () => {
    expect(() => loadWorkerConfig({ ...base(), NODE_ENV: 'production' })).toThrow(/not allowed in production/)
    expect(() =>
      loadWorkerConfig({ ...base(), NODE_ENV: 'production', PEERCHIVE_MALWARE_SCANNER: 'clamav' }),
    ).toThrow(/Storage driver "filesystem" is not allowed/)
    expect(() =>
      loadWorkerConfig({ ...base(), PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION: '1' }),
    ).toThrow(/Malware scanner "signature-only" is not allowed/)
    const ok = loadWorkerConfig({
      ...base(),
      PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION: '1',
      PEERCHIVE_MALWARE_SCANNER: 'clamav',
      CLAMAV_HOST: 'clamav',
    })
    expect(ok).toMatchObject({ production: true })
    expect(ok.scanner.engine).toBe('clamav')
  })

  it('requires DATABASE_URL and a sane concurrency', () => {
    expect(() => loadWorkerConfig({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/)
    expect(() => loadWorkerConfig({ ...base(), NODE_ENV: 'development', PEERCHIVE_SCAN_CONCURRENCY: '0' })).toThrow()
    expect(() => loadWorkerConfig({ ...base(), NODE_ENV: 'development', PEERCHIVE_SCAN_CONCURRENCY: '100' })).toThrow()
  })
})

describe('scan job handler', () => {
  it('ignores malformed payloads without touching the database', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = new Proxy({}, { get: () => { throw new Error('db must not be used') } })
    await handleScanJob(db as never, {} as never, { id: 'job', data: { versionId: '../x' }, retryCount: 0 })
    await handleScanJob(db as never, {} as never, { id: 'job', data: {}, retryCount: 0 })
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('retries with exponential backoff and dead-letters after the limit', () => {
    expect(SCAN_QUEUE_OPTIONS).toMatchObject({ retryLimit: 5, retryBackoff: true, deadLetter: 'artifact-scan-dead' })
  })
})
