import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeStorageContract } from './storage-contract'
import {
  type ObjectKey,
  type ObjectStorage,
  InvalidObjectKeyError,
  ObjectTooLargeError,
  cleanKeyFor,
  createFilesystemStorage,
  isObjectKey,
  newQuarantineKey,
  readAll,
  resolveMalwareScanner,
  resolveObjectStorage,
  resolveStorageRoot,
  writeObject,
} from '../src'

let root: string
let storage: ObjectStorage

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'peerchive-objects-'))
  storage = createFilesystemStorage(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 디렉터리 아래 모든 파일(상대 경로). */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
}

describe('object keys', () => {
  it('accepts only server-made quarantine/clean UUID keys', () => {
    expect(isObjectKey(newQuarantineKey())).toBe(true)
    expect(isObjectKey(cleanKeyFor(crypto.randomUUID()))).toBe(true)
    for (const bad of [
      '../etc/passwd',
      'quarantine/../../x',
      '/abs/path',
      'clean/not-a-uuid',
      'public/123e4567-e89b-12d3-a456-426614174000',
      'quarantine/123e4567-e89b-12d3-a456-426614174000/..',
      'quarantine\\123e4567-e89b-12d3-a456-426614174000',
      'quarantine/report.pdf',
      '',
    ]) {
      expect(isObjectKey(bad)).toBe(false)
    }
    expect(() => cleanKeyFor('../x')).toThrow()
  })
})

describeStorageContract('filesystem', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'peerchive-objects-contract-'))
  return { storage: createFilesystemStorage(dir), cleanup: () => rm(dir, { recursive: true, force: true }) }
})

describe('filesystem storage', () => {
  it('requires an absolute root', () => {
    expect(() => createFilesystemStorage('relative/dir')).toThrow()
  })

  it('leaves no partial file behind when a put aborts at maxBytes', async () => {
    const key = newQuarantineKey()
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(10, 1))
    await expect(storage.put(key, Readable.from(chunks), { maxBytes: 25 })).rejects.toBeInstanceOf(ObjectTooLargeError)
    expect(await listFiles(root)).toEqual([])
  })

  it('writeObject leaves only the clean file on disk', async () => {
    const clean = cleanKeyFor(crypto.randomUUID())
    await writeObject(storage, clean, Buffer.from('original'))
    await writeObject(storage, clean, Buffer.from('stripped!'))
    expect(await listFiles(root)).toEqual([path.join('clean', clean.slice(6, 8), clean.slice(6))])
  })

  it('stores under random key paths only (never the original file name) with private permissions', async () => {
    const key = newQuarantineKey()
    await storage.put(key, Readable.from([Buffer.from('x')]), { maxBytes: 10 })
    const [file] = await listFiles(root)
    const id = key.split('/')[1]!
    expect(file).toBe(path.join('quarantine', id.slice(0, 2), id))
    expect((await stat(path.join(root, file!))).mode & 0o777).toBe(0o600)
  })

  it('never reaches a file outside the root through a traversal key', async () => {
    // 루트 밖에 미끼 파일을 둡니다(키 형식 검사는 공통 계약 테스트에서 모든 메서드에 대해 확인).
    const outside = path.join(root, '..', `peerchive-outside-${crypto.randomUUID()}.txt`)
    await writeFile(outside, 'secret')
    const bad = `../${path.basename(outside)}` as ObjectKey
    await expect(storage.get(bad)).rejects.toBeInstanceOf(InvalidObjectKeyError)
    await expect(storage.delete(bad)).rejects.toBeInstanceOf(InvalidObjectKeyError)
    expect((await stat(outside)).size).toBe(6)
    await rm(outside, { force: true })
  })

  it('lists keys under a prefix, skipping temp and foreign files', async () => {
    const q = newQuarantineKey()
    const c = cleanKeyFor(crypto.randomUUID())
    await storage.put(q, Readable.from([Buffer.from('q')]), { maxBytes: 10 })
    await storage.put(c, Readable.from([Buffer.from('c')]), { maxBytes: 10 })
    const id = q.split('/')[1]!
    await writeFile(path.join(root, 'quarantine', id.slice(0, 2), `${id}.x.part`), 'partial')
    await writeFile(path.join(root, 'quarantine', id.slice(0, 2), 'notes.txt'), 'x')
    const seen: Array<{ key: string; modifiedAt: Date }> = []
    for await (const item of storage.list('quarantine')) seen.push(item)
    expect(seen.map((s) => s.key)).toEqual([q])
    expect(seen[0]!.modifiedAt).toBeInstanceOf(Date)
    const cleanKeys: string[] = []
    for await (const item of storage.list('clean')) cleanKeys.push(item.key)
    expect(cleanKeys).toEqual([c])
  })
})

describe('storage/scanner configuration', () => {
  it('resolves a relative root against the workspace root', () => {
    const resolved = resolveStorageRoot(undefined, path.join(process.cwd(), 'src'))
    expect(resolved.endsWith(path.join('.data', 'objects'))).toBe(true)
    expect(resolveStorageRoot('/srv/objects', '/anywhere')).toBe('/srv/objects')
  })

  it('refuses filesystem storage in production unless explicitly allowed', () => {
    expect(() => resolveObjectStorage({}, { production: true })).toThrow(/not allowed in production/)
    expect(resolveObjectStorage({ PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION: '1', PEERCHIVE_STORAGE_ROOT: root }, { production: true }).driver).toBe('filesystem')
    expect(resolveObjectStorage({ PEERCHIVE_STORAGE_ROOT: root }, { production: false }).driver).toBe('filesystem')
    expect(() => resolveObjectStorage({ PEERCHIVE_STORAGE_DRIVER: 'gcs' }, { production: false })).toThrow(/Unknown/)
  })

  it('refuses the signature-only scanner in production', () => {
    expect(() => resolveMalwareScanner({}, { production: true })).toThrow(/not allowed in production/)
    expect(resolveMalwareScanner({}, { production: false }).engine).toBe('signature-only')
    expect(resolveMalwareScanner({ PEERCHIVE_MALWARE_SCANNER: 'clamav' }, { production: true }).engine).toBe('clamav')
    expect(() => resolveMalwareScanner({ PEERCHIVE_MALWARE_SCANNER: 'clamav', CLAMAV_PORT: 'x' }, { production: true })).toThrow()
    expect(() => resolveMalwareScanner({ PEERCHIVE_MALWARE_SCANNER: 'none' }, { production: false })).toThrow(/Unknown/)
  })
})
