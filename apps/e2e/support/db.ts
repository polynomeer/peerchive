/**
 * E2E 전용 DB(peerchive_e2e)에 직접 하는 일. 테스트 대상 동작이 아닌 준비 단계만 여기에 둡니다.
 *
 * - 로그인 IP rate limit(15분 20회, ADR 0006): 모든 테스트가 같은 루프백 IP로 로그인하므로, 링크를 요청하기 전에
 *   `magic_link_ip:` 카운터만 지웁니다(이메일별 카운터·다른 한도는 그대로).
 * - 운영자 부여: 실제 운영 절차와 같은 CLI(`pnpm --filter @peerchive/db grant-operator`)를 E2E DB로 실행합니다.
 * - 학교 메일 도메인 등록(C-01): 파일럿 전 운영 절차와 같은 CLI(`pnpm --filter @peerchive/db school-email-domain add`)를 E2E DB로 실행합니다.
 * - 이름 표시 방식 변경 적용(C-03): 7일을 기다릴 수 없으므로 그 방의 scheduled 예약의 requested_at·effective_at을 함께 7일 1분 앞당기고
 *   (DB check `effective_at = requested_at + 7일` 유지), worker와 같은 적용 함수를 CLI(`pnpm --filter worker apply-name-modes`)로 한 번 실행합니다.
 *   E2E worker의 1분 주기 작업이 먼저 적용해도 결과는 같습니다(조건부 update, 알림 중복 없음).
 */
import { execFileSync } from 'node:child_process'
import postgres from 'postgres'
import { REPO_ROOT, e2eDatabaseUrl } from './env'

let client: ReturnType<typeof postgres> | null = null

export function e2eSql(): ReturnType<typeof postgres> {
  client ??= postgres(e2eDatabaseUrl(), { max: 2, idle_timeout: 5, onnotice: () => {} })
  return client
}

export async function resetLoginIpRateLimit(): Promise<void> {
  await e2eSql()`delete from rate_limit_buckets where key like 'magic_link_ip:%'`
}

/**
 * 학교 메일 인증 요청의 IP 한도 카운터만 비웁니다(C-06 시나리오가 늘어 모든 테스트가 같은 루프백 IP로 인증하면 한도에 걸림).
 * 사용자별·주소별 한도는 그대로입니다. 로그인 IP 한도를 비우는 것과 같은 이유입니다.
 */
export async function resetAffiliationIpRateLimit(): Promise<void> {
  await e2eSql()`delete from rate_limit_buckets where key like 'affiliation_ip:%'`
}

export function grantOperator(email: string): void {
  execFileSync('pnpm', ['--filter', '@peerchive/db', 'grant-operator', email], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl() },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function registerSchoolDomain(schoolId: string, domain: string): void {
  execFileSync('pnpm', ['--filter', '@peerchive/db', 'school-email-domain', 'add', schoolId, domain], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl() },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 방(slug)의 예약을 기한이 지난 것으로 옮기고 적용 명령을 실행합니다. 옮긴 예약 수. */
export async function applyNameModeChangeNow(slug: string): Promise<number> {
  const moved = await e2eSql()`
    update name_mode_changes set requested_at = requested_at - interval '7 days 1 minute', effective_at = effective_at - interval '7 days 1 minute'
    where status = 'scheduled' and space_id = (select id from community_spaces where slug = ${slug})
    returning id`
  execFileSync('pnpm', ['--filter', 'worker', 'apply-name-modes'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl(), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return moved.length
}
