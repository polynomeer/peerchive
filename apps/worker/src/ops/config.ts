/**
 * 운영 작업 설정(T-16, ADR 0016): 주기 정리 일정·배치 크기, 탈퇴 정리 유예 기간, pepper.
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_DELETION_PEPPER | (개발용 고정 값) | 삭제 장부 HMAC 비밀. production에서 없거나 약하면 worker·재적용 명령이 시작하지 않음. 바꾸지 않음 |
 * | PEERCHIVE_ANALYTICS_PEPPER | (개발용 고정 값) | 분석 이벤트 HMAC 비밀(웹과 같은 값). 탈퇴 정리 때 그 사람의 이벤트를 찾는 데만 씀. 없으면 이벤트 삭제를 건너뜀 |
 * | PEERCHIVE_DELETION_GRACE_DAYS | 7 | 탈퇴 요청 뒤 정리까지 유예 일수(0–90). 0이면 다음 정리 주기에 바로 |
 * | PEERCHIVE_OPS_BATCH_SIZE | 500 | 정리 작업 한 번의 삭제 행 수(10–10000) |
 * | PEERCHIVE_CRON_<작업> | 작업별 기본값 | 5필드 cron(Asia/Seoul) 또는 `off`. 예: PEERCHIVE_CRON_ACCOUNT_PURGE='* * * * *' |
 * | NUXT_SITE_ORIGIN | (없음) | 웹과 같은 값(쉼표 구분, 첫 항목). 소셜 링크 되돌림 확인(S-06)이 찾을 프로필 주소의 origin. 없으면 확인·재확인을 건너뜀 |
 */
import { DELETION_PEPPER_ENV, ANALYTICS_PEPPER_ENV, isProductionMode, resolvePepper } from '@peerchive/db'

export const OPS_TASK_NAMES = [
  'upload-intents',
  'orphan-quarantine',
  'rate-limit-buckets',
  'internal-nonces',
  'magic-link-tokens',
  'sessions',
  'discord-codes',
  'pin-requests',
  'outbox',
  'affiliation-codes',
  'account-purge',
  'name-mode-changes',
  'social-link-recheck',
  'certificate-files',
  'course-term-prompts',
  'ai-retro-sessions',
  'ai-meeting-drafts',
  'ai-case-polish',
  'share-links',
] as const
export type OpsTaskName = (typeof OPS_TASK_NAMES)[number]

/** 기본 일정(Asia/Seoul). 서로 겹치지 않게 분을 흩어 둡니다. */
export const DEFAULT_CRONS: Record<OpsTaskName, string> = {
  'upload-intents': '*/15 * * * *',
  'orphan-quarantine': '23 * * * *',
  'rate-limit-buckets': '7 * * * *',
  'internal-nonces': '*/10 * * * *',
  'magic-link-tokens': '11 3 * * *',
  sessions: '13 * * * *',
  'discord-codes': '17 * * * *',
  'pin-requests': '*/10 * * * *',
  outbox: '41 4 * * *',
  'affiliation-codes': '27 * * * *',
  'account-purge': '*/30 * * * *',
  // 이름 표시 방식 변경 적용(C-03): effective_at이 지난 예약을 1분 안에 적용합니다(웹은 그 사이에도 새 방식으로 씀).
  'name-mode-changes': '* * * * *',
  // 소셜 링크 재확인(S-06): 매시 verified 링크 중 24시간 지난 것 최대 100개. 링크마다 대략 하루 한 번입니다.
  'social-link-recheck': '37 * * * *',
  // 수료증 파일 삭제(I-01, ADR 0037): 결정·취소된 수료증 파일을 10분 안에 지우고 삭제 장부(source retention)에 남깁니다(최대 보존 7일 안).
  'certificate-files': '*/10 * * * *',
  // 학기 종료 알림(E-01, ADR 0046): 종료 시각이 지난 과목 등록마다 한 번 화면 안 알림(선배 노트·공개 제안)을 만듭니다.
  'course-term-prompts': '53 * * * *',
  // AI 회고 인터뷰(E-12, ADR 0057): 만든 지 7일 지난 세션(질문·답변)과 그 초안을 지웁니다(웹도 읽을 때 지움). AI가 꺼져 있어도 남은 행을 지웁니다.
  'ai-retro-sessions': '19 * * * *',
  // AI 회의 요약(E-13, ADR 0058): 만든 지 7일 지난 승인 전 회의 요약 초안을 지웁니다(웹도 읽을 때 지움). AI가 꺼져 있어도 남은 행을 지웁니다.
  'ai-meeting-drafts': '23 * * * *',
  // AI 케이스 다듬기(E-14, ADR 0059): 만든 지 7일 지난 다듬기 제안(받아들이지 않은 AI 문장)을 지웁니다(웹도 읽을 때 무시). AI가 꺼져 있어도 남은 행을 지웁니다.
  'ai-case-polish': '29 * * * *',
  // 제한 공유 링크(E-07, ADR 0060 D-09): 철회·만료·판 교체로 끝난 지 90일 지난 링크 행을 지웁니다.
  'share-links': '43 4 * * *',
}

export const OPS_TIMEZONE = 'Asia/Seoul'

export interface OpsConfig {
  production: boolean
  deletionPepper: string
  analyticsPepper: string | null
  graceDays: number
  batchSize: number
  /** 사이트 첫 origin(NUXT_SITE_ORIGIN). 소셜 링크 되돌림 확인이 찾을 프로필 주소의 origin. 없으면 null. */
  siteOrigin: string | null
  /** null이면 그 작업을 예약하지 않음(off). */
  crons: Record<OpsTaskName, string | null>
}

type Env = Readonly<Record<string, string | undefined>>

export const cronEnvName = (task: OpsTaskName) => `PEERCHIVE_CRON_${task.toUpperCase().replace(/-/g, '_')}`

const CRON_FIELD = /^[0-9*/,-]+$/

/** 5필드 cron 형식만 받습니다(값의 범위는 pg-boss가 검사). */
export function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/)
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f))
}

function intEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer ${min}–${max}`)
  return value
}

/** NUXT_SITE_ORIGIN(쉼표 구분)의 첫 http(s) origin. 웹의 primarySiteOrigin과 같은 규칙입니다. */
export function siteOriginFrom(env: Env): string | null {
  for (const item of (env.NUXT_SITE_ORIGIN ?? '').split(',')) {
    const value = item.trim()
    if (!value || value === 'null') continue
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    } catch {
      // 다음 항목
    }
  }
  return null
}

export function loadOpsConfig(env: Env): OpsConfig {
  const production = isProductionMode(env)
  const deletionPepper = resolvePepper(env, DELETION_PEPPER_ENV)
  if (!deletionPepper) {
    throw new Error(`${DELETION_PEPPER_ENV} is missing or weak (production requires a random secret of 32+ characters, e.g. openssl rand -hex 32)`)
  }
  const crons = {} as Record<OpsTaskName, string | null>
  for (const task of OPS_TASK_NAMES) {
    const name = cronEnvName(task)
    const raw = env[name]?.trim()
    if (!raw) crons[task] = DEFAULT_CRONS[task]
    else if (raw === 'off') crons[task] = null
    else if (isCronExpression(raw)) crons[task] = raw
    else throw new Error(`${name} must be a 5-field cron expression or "off"`)
  }
  return {
    production,
    deletionPepper,
    analyticsPepper: resolvePepper(env, ANALYTICS_PEPPER_ENV),
    graceDays: intEnv(env, 'PEERCHIVE_DELETION_GRACE_DAYS', 7, 0, 90),
    batchSize: intEnv(env, 'PEERCHIVE_OPS_BATCH_SIZE', 500, 10, 10_000),
    siteOrigin: siteOriginFrom(env),
    crons,
  }
}
