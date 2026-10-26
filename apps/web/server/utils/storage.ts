import { type ObjectStorage, resolveObjectStorage } from '@peerchive/files'

let storage: ObjectStorage | undefined

/**
 * 오브젝트 저장소(프로세스당 하나). 설정은 worker와 같은 환경 변수(PEERCHIVE_STORAGE_*, PEERCHIVE_S3_*)를 읽습니다.
 * production에서 filesystem driver는 PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION=1일 때만, s3 driver는 설정이 모두 있고
 * endpoint가 https일 때만 허용합니다(ADR 0007·0017).
 */
export function useObjectStorage(): ObjectStorage {
  storage ??= resolveObjectStorage(process.env, { production: isProduction() })
  return storage
}
