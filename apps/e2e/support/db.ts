/**
 * E2E 전용 DB(peerchive_e2e)에 직접 하는 일. 테스트 대상 동작이 아닌 준비 단계만 여기에 둡니다.
 *
 * - 로그인 IP rate limit(15분 20회, ADR 0006): 모든 테스트가 같은 루프백 IP로 로그인하므로, 링크를 요청하기 전에
 *   `magic_link_ip:` 카운터만 지웁니다(이메일별 카운터·다른 한도는 그대로).
 * - 운영자 부여: 실제 운영 절차와 같은 CLI(`pnpm --filter @peerchive/db grant-operator`)를 E2E DB로 실행합니다.
 * - 학교 메일 도메인 등록(C-01): 파일럿 전 운영 절차와 같은 CLI(`pnpm --filter @peerchive/db school-email-domain add`)를 E2E DB로 실행합니다.
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
