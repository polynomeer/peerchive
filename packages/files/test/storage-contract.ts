/**
 * ObjectStorage 공통 계약 테스트. 모든 driver(filesystem, s3)가 같은 테스트를 통과해야 합니다(ADR 0007·0017).
 * driver마다 다른 것(파일 권한, 임시 파일 이름 등)은 각 driver 테스트 파일에 둡니다.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ObjectKey,
  type ObjectStorage,
  InvalidObjectKeyError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  cleanKeyFor,
  newQuarantineKey,
  readAll,
  writeObject,
} from '../src'

export interface StorageHarness {
  storage: ObjectStorage
  /** 끝난 뒤 정리(임시 디렉터리·prefix 삭제). */
  cleanup(): Promise<void>
}

/** 목록 페이지 넘김을 확인할 수 있도록 harness는 한 페이지를 작게(2개) 잡아 주세요. */
export function describeStorageContract(name: string, makeHarness: () => Promise<StorageHarness>, options: { skip?: boolean } = {}) {
  describe.skipIf(!!options.skip)(`ObjectStorage contract: ${name}`, () => {
    let harness: StorageHarness
    let storage: ObjectStorage
    beforeEach(async () => {
      harness = await makeHarness()
      storage = harness.storage
    })
    afterEach(async () => {
      await harness.cleanup()
    })

    const body = (...parts: string[]) => Readable.from(parts.map((p) => Buffer.from(p)))
    const keysOf = async (prefix: 'quarantine' | 'clean') => {
      const keys: string[] = []
      for await (const item of storage.list(prefix)) keys.push(item.key)
      return keys.sort()
    }

    it('puts, heads, reads, refuses to overwrite, moves idempotently and deletes idempotently', async () => {
      const key = newQuarantineKey()
      const result = await storage.put(key, body('hello ', 'world'), { maxBytes: 100 })
      expect(result).toEqual({
        bytes: 11,
        sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      })
      expect(await storage.head(key)).toEqual({ bytes: 11 })
      // 같은 키에 다시 쓰지 않습니다(키는 일회성). 원래 내용은 그대로입니다.
      await expect(storage.put(key, body('x'), { maxBytes: 10 })).rejects.toThrow()
      expect((await readAll(await storage.get(key))).toString()).toBe('hello world')

      const clean = cleanKeyFor(crypto.randomUUID())
      await storage.move(key, clean)
      await storage.move(key, clean) // 재실행해도 성공
      expect(await storage.head(key)).toBeNull()
      expect((await readAll(await storage.get(clean))).toString()).toBe('hello world')

      await storage.delete(clean)
      await storage.delete(clean) // 없어도 성공
      await expect(storage.get(clean)).rejects.toBeInstanceOf(ObjectNotFoundError)
      expect(await storage.head(clean)).toBeNull()
      await expect(storage.move(key, clean)).rejects.toBeInstanceOf(ObjectNotFoundError)
      await expect(storage.copy(key, clean)).rejects.toBeInstanceOf(ObjectNotFoundError)
    })

    it('computes the SHA-256 of streamed content correctly', async () => {
      const content = randomBytes(256 * 1024 + 17)
      const chunks = Array.from({ length: 9 }, (_, i) => content.subarray(i * 29_131, (i + 1) * 29_131)).filter((c) => c.length)
      const key = newQuarantineKey()
      const result = await storage.put(key, Readable.from(chunks), { maxBytes: content.length })
      expect(result).toEqual({ bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
      expect((await readAll(await storage.get(key))).equals(content)).toBe(true)
      // 빈 내용도 됩니다.
      const empty = newQuarantineKey()
      expect(await storage.put(empty, Readable.from([]), { maxBytes: 10 })).toEqual({
        bytes: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      })
      expect(await storage.head(empty)).toEqual({ bytes: 0 })
    })

    it('reads byte ranges (inclusive end, open end)', async () => {
      const key = newQuarantineKey()
      await storage.put(key, body('0123456789'), { maxBytes: 10 })
      const read = async (start: number, end?: number) =>
        (await readAll(await storage.get(key, end === undefined ? { start } : { start, end }))).toString()
      expect(await read(0, 0)).toBe('0')
      expect(await read(0, 4)).toBe('01234')
      expect(await read(3, 6)).toBe('3456')
      expect(await read(7)).toBe('789')
      expect(await read(5, 100)).toBe('56789')
    })

    it('aborts at maxBytes and leaves nothing behind', async () => {
      const key = newQuarantineKey()
      const chunks = Array.from({ length: 5 }, () => Buffer.alloc(10, 1))
      await expect(storage.put(key, Readable.from(chunks), { maxBytes: 25 })).rejects.toBeInstanceOf(ObjectTooLargeError)
      expect(await storage.head(key)).toBeNull()
      expect(await keysOf('quarantine')).toEqual([])
      // 정확히 한도까지는 됩니다.
      expect((await storage.put(key, Readable.from(chunks.slice(0, 2)), { maxBytes: 20 })).bytes).toBe(20)
    })

    it('copy keeps the source; move overwrites an existing target with the new content', async () => {
      const a = newQuarantineKey()
      const clean = cleanKeyFor(crypto.randomUUID())
      await storage.put(a, body('first'), { maxBytes: 10 })
      await storage.copy(a, clean)
      expect(await storage.head(a)).toEqual({ bytes: 5 })
      expect((await readAll(await storage.get(clean))).toString()).toBe('first')

      const b = newQuarantineKey()
      await storage.put(b, body('second!'), { maxBytes: 10 })
      await storage.move(b, clean)
      expect(await storage.head(b)).toBeNull()
      expect(await storage.head(clean)).toEqual({ bytes: 7 })
      expect((await readAll(await storage.get(clean))).toString()).toBe('second!')
    })

    it('writeObject replaces an existing key via a staging key and leaves nothing else behind', async () => {
      const clean = cleanKeyFor(crypto.randomUUID())
      expect(await writeObject(storage, clean, Buffer.from('original'))).toMatchObject({ bytes: 8 })
      const result = await writeObject(storage, clean, Buffer.from('stripped!'))
      expect(result).toEqual({ bytes: 9, sha256: createHash('sha256').update('stripped!').digest('hex') })
      expect((await readAll(await storage.get(clean))).toString()).toBe('stripped!')
      expect(await keysOf('clean')).toEqual([clean])
      expect(await keysOf('quarantine')).toEqual([])
    })

    it('lists keys per prefix across pages with modification times', async () => {
      expect(await keysOf('quarantine')).toEqual([])
      const quarantine = Array.from({ length: 5 }, () => newQuarantineKey())
      const clean = cleanKeyFor(crypto.randomUUID())
      for (const key of quarantine) await storage.put(key, body('q'), { maxBytes: 10 })
      await storage.put(clean, body('c'), { maxBytes: 10 })
      const seen: Array<{ key: string; modifiedAt: Date }> = []
      for await (const item of storage.list('quarantine')) seen.push(item)
      expect(seen.map((s) => s.key).sort()).toEqual([...quarantine].sort())
      for (const item of seen) {
        expect(item.modifiedAt).toBeInstanceOf(Date)
        expect(Math.abs(item.modifiedAt.getTime() - Date.now())).toBeLessThan(10 * 60 * 1000)
      }
      expect(await keysOf('clean')).toEqual([clean])
    })

    it('rejects malformed keys on every method', async () => {
      const bad = '../peerchive-outside.txt' as ObjectKey
      const other = 'public/123e4567-e89b-12d3-a456-426614174000' as ObjectKey
      for (const key of [bad, other]) {
        await expect(storage.get(key)).rejects.toBeInstanceOf(InvalidObjectKeyError)
        await expect(storage.head(key)).rejects.toBeInstanceOf(InvalidObjectKeyError)
        await expect(storage.delete(key)).rejects.toBeInstanceOf(InvalidObjectKeyError)
        await expect(storage.move(key, newQuarantineKey())).rejects.toBeInstanceOf(InvalidObjectKeyError)
        await expect(storage.move(newQuarantineKey(), key)).rejects.toBeInstanceOf(InvalidObjectKeyError)
        await expect(storage.copy(newQuarantineKey(), key)).rejects.toBeInstanceOf(InvalidObjectKeyError)
        await expect(storage.put(key, body('x'), { maxBytes: 10 })).rejects.toBeInstanceOf(InvalidObjectKeyError)
      }
    })
  })
}
