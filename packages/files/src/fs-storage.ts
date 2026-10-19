/**
 * 파일시스템 driver(로컬 개발·단일 서버 pilot용, ADR 0007).
 *
 * - 루트 아래 `<prefix>/<uuid 앞 2자>/<uuid>`에 저장합니다. 키 형식 검사(isObjectKey)와
 *   "결과 경로가 루트 안인지" 검사를 함께 해 경로 조작이 불가능합니다.
 * - 쓰기는 같은 디렉터리의 임시 파일(`.part`)에 한 뒤 rename해서, 중단된 업로드가 완성본처럼 보이지 않게 합니다.
 * - 디렉터리 0700, 파일 0600. 이 디렉터리를 웹 서버의 정적 경로로 노출하지 마세요.
 * - production에서는 명시적으로 허용할 때만 씁니다(config.ts).
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import {
  type ByteRange,
  type ObjectKey,
  type ObjectStorage,
  type PutResult,
  InvalidObjectKeyError,
  ObjectNotFoundError,
  ObjectTooLargeError,
  assertObjectKey,
} from './storage'

const isErrno = (error: unknown, code: string) => (error as NodeJS.ErrnoException | null)?.code === code

export function createFilesystemStorage(rootDir: string): ObjectStorage {
  if (!path.isAbsolute(rootDir)) throw new Error('filesystem storage root must be an absolute path')
  const root = path.resolve(rootDir)

  /** 키 → 절대 경로. 형식이 다르거나 루트 밖이면 예외. */
  function resolveKey(key: ObjectKey): string {
    assertObjectKey(key)
    const [prefix, id] = key.split('/') as [string, string]
    const full = path.resolve(root, prefix, id.slice(0, 2), id)
    if (!full.startsWith(root + path.sep)) throw new InvalidObjectKeyError()
    return full
  }

  async function ensureDir(file: string) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  }

  return {
    driver: 'filesystem',

    async put(key, body, { maxBytes }): Promise<PutResult> {
      const target = resolveKey(key)
      await ensureDir(target)
      const temp = `${target}.${randomUUID()}.part`
      const hash = createHash('sha256')
      let bytes = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength
          if (bytes > maxBytes) return callback(new ObjectTooLargeError(maxBytes))
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      try {
        await pipeline(body, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
        // link는 대상이 있으면 실패하므로 같은 키를 덮어쓰지 않습니다.
        await link(temp, target)
      } finally {
        await unlink(temp).catch(() => {})
      }
      return { bytes, sha256: hash.digest('hex') }
    },

    async get(key, range?: ByteRange): Promise<Readable> {
      const file = resolveKey(key)
      try {
        await stat(file)
      } catch (error) {
        if (isErrno(error, 'ENOENT')) throw new ObjectNotFoundError()
        throw error
      }
      return createReadStream(file, range ? { start: range.start, end: range.end } : {})
    },

    async head(key) {
      try {
        const info = await stat(resolveKey(key))
        return { bytes: info.size }
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return null
        throw error
      }
    },

    async copy(from, to) {
      const source = resolveKey(from)
      const target = resolveKey(to)
      await ensureDir(target)
      try {
        await copyFile(source, target)
      } catch (error) {
        if (isErrno(error, 'ENOENT')) throw new ObjectNotFoundError()
        throw error
      }
    },

    async move(from, to) {
      const source = resolveKey(from)
      const target = resolveKey(to)
      await ensureDir(target)
      try {
        await rename(source, target)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
        // 원본이 없으면 이미 옮겨진 경우(재실행)인지 확인합니다.
        try {
          await stat(target)
        } catch {
          throw new ObjectNotFoundError()
        }
      }
    },

    async delete(key) {
      try {
        await unlink(resolveKey(key))
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
    },
  }
}
