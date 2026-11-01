/**
 * 파일 검사 큐(ADR 0004, 0007). 재시도·backoff·dead-letter를 큐에 설정하고, 마지막 시도인지 작업에 알려 줍니다.
 */
import type { PgBoss } from 'pg-boss'
import type { DbExecutor } from '@peerchive/db'
import {
  ALBUM_PHOTO_SCAN_QUEUE,
  type AlbumPhotoScanJobData,
  ARTIFACT_SCAN_QUEUE,
  CERTIFICATE_SCAN_QUEUE,
  type CertificateScanJobData,
  type ScanDeps,
  type ScanJobData,
  scanAlbumPhoto,
  scanArtifactVersion,
  scanCertificateCheck,
} from '@peerchive/files'

export const SCAN_DEAD_LETTER_QUEUE = `${ARTIFACT_SCAN_QUEUE}-dead`
export const CERTIFICATE_SCAN_DEAD_LETTER_QUEUE = `${CERTIFICATE_SCAN_QUEUE}-dead`
export const ALBUM_PHOTO_SCAN_DEAD_LETTER_QUEUE = `${ALBUM_PHOTO_SCAN_QUEUE}-dead`

/** 재시도 정책: 최대 5번 다시(처음 포함 6번), 30초부터 지수 backoff(최대 30분), 한 번에 5분 넘으면 만료 후 재시도. */
export const SCAN_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 30 * 60,
  expireInSeconds: 5 * 60,
  deadLetter: SCAN_DEAD_LETTER_QUEUE,
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 작업 하나 처리. 테스트에서도 직접 부릅니다. 예외를 던지면 pg-boss가 재시도합니다. */
export async function handleScanJob(
  db: DbExecutor,
  deps: ScanDeps,
  job: { id: string; data: Partial<ScanJobData>; retryCount: number },
): Promise<void> {
  const versionId = job.data?.versionId
  if (typeof versionId !== 'string' || !UUID.test(versionId)) {
    // 형식이 잘못된 작업은 재시도해도 같으므로 기록만 하고 끝냅니다.
    console.error(`[worker] scan job ${job.id}: invalid payload`)
    return
  }
  const finalAttempt = job.retryCount >= SCAN_QUEUE_OPTIONS.retryLimit
  const outcome = await scanArtifactVersion(db, deps, versionId, { finalAttempt })
  // 로그에는 버전 id와 결과 코드만 남깁니다(파일 이름·내용 없음).
  const detail = outcome.status === 'quarantined' ? ` reason=${outcome.reason}${outcome.signature ? ` signature=${outcome.signature}` : ''}` : ''
  console.info(`[worker] scan ${versionId}: ${outcome.status}${detail}`)
}

export async function registerScanQueue(boss: PgBoss, db: DbExecutor, deps: ScanDeps, concurrency: number): Promise<void> {
  await boss.createQueue(SCAN_DEAD_LETTER_QUEUE)
  await boss.createQueue(ARTIFACT_SCAN_QUEUE, SCAN_QUEUE_OPTIONS)
  // 이미 있던 큐에도 현재 정책을 적용합니다.
  await boss.updateQueue(ARTIFACT_SCAN_QUEUE, SCAN_QUEUE_OPTIONS)
  await boss.work<ScanJobData>(
    ARTIFACT_SCAN_QUEUE,
    { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (job) await handleScanJob(db, deps, job)
    },
  )
}

/** 수료증 검사 작업 하나(I-01, ADR 0037). 산출물 검사와 같은 재시도 정책입니다. */
export async function handleCertificateScanJob(
  db: DbExecutor,
  deps: ScanDeps,
  job: { id: string; data: Partial<CertificateScanJobData>; retryCount: number },
): Promise<void> {
  const checkId = job.data?.checkId
  if (typeof checkId !== 'string' || !UUID.test(checkId)) {
    console.error(`[worker] certificate scan job ${job.id}: invalid payload`)
    return
  }
  const finalAttempt = job.retryCount >= SCAN_QUEUE_OPTIONS.retryLimit
  const outcome = await scanCertificateCheck(db, deps, checkId, { finalAttempt })
  // 로그에는 확인 id와 결과 코드만 남깁니다(파일·사용자 정보 없음).
  const detail = outcome.status === 'quarantined' ? ` reason=${outcome.reason}` : ''
  console.info(`[worker] certificate scan ${checkId}: ${outcome.status}${detail}`)
}

export async function registerCertificateScanQueue(boss: PgBoss, db: DbExecutor, deps: ScanDeps): Promise<void> {
  const options = { ...SCAN_QUEUE_OPTIONS, deadLetter: CERTIFICATE_SCAN_DEAD_LETTER_QUEUE }
  await boss.createQueue(CERTIFICATE_SCAN_DEAD_LETTER_QUEUE)
  await boss.createQueue(CERTIFICATE_SCAN_QUEUE, options)
  await boss.updateQueue(CERTIFICATE_SCAN_QUEUE, options)
  await boss.work<CertificateScanJobData>(CERTIFICATE_SCAN_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await handleCertificateScanJob(db, deps, job)
  })
}

/** 앨범 사진 검사 작업 하나(A-02, ADR 0039). 산출물 검사와 같은 재시도 정책입니다. */
export async function handleAlbumPhotoScanJob(
  db: DbExecutor,
  deps: ScanDeps,
  job: { id: string; data: Partial<AlbumPhotoScanJobData>; retryCount: number },
): Promise<void> {
  const photoId = job.data?.photoId
  if (typeof photoId !== 'string' || !UUID.test(photoId)) {
    console.error(`[worker] album photo scan job ${job.id}: invalid payload`)
    return
  }
  const finalAttempt = job.retryCount >= SCAN_QUEUE_OPTIONS.retryLimit
  const outcome = await scanAlbumPhoto(db, deps, photoId, { finalAttempt })
  // 로그에는 사진 id와 결과 코드만 남깁니다(파일·사용자·방 정보 없음).
  const detail = outcome.status === 'quarantined' ? ` reason=${outcome.reason}` : ''
  console.info(`[worker] album photo scan ${photoId}: ${outcome.status}${detail}`)
}

export async function registerAlbumPhotoScanQueue(boss: PgBoss, db: DbExecutor, deps: ScanDeps): Promise<void> {
  const options = { ...SCAN_QUEUE_OPTIONS, deadLetter: ALBUM_PHOTO_SCAN_DEAD_LETTER_QUEUE }
  await boss.createQueue(ALBUM_PHOTO_SCAN_DEAD_LETTER_QUEUE)
  await boss.createQueue(ALBUM_PHOTO_SCAN_QUEUE, options)
  await boss.updateQueue(ALBUM_PHOTO_SCAN_QUEUE, options)
  await boss.work<AlbumPhotoScanJobData>(ALBUM_PHOTO_SCAN_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (job) await handleAlbumPhotoScanJob(db, deps, job)
  })
}
