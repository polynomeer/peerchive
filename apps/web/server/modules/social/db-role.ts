/**
 * social 읽기 경로를 social DB 역할로 실행(S-05, SYSTEM_DESIGN §8.3 불변조건 1 "social 모듈이 쓰는 DB 역할에는 커뮤니티 글 테이블의 SELECT 권한이
 * 없음", ADR 0029 §2 후속 → ADR 0035).
 *
 * 활동 목록·팔로우 피드·팔로우 추천은 트랜잭션을 열고 `SET LOCAL ROLE peerchive_social`로 바꾼 뒤 읽습니다. 그 역할은 커뮤니티 테이블·원천 테이블
 * (선배 노트·공개 후보)에 권한이 없고, 원본 상태 재확인과 카드 내용은 `persona_activity_cards`(SECURITY DEFINER) 하나로만 얻습니다. 코드가 실수로
 * 커뮤니티 테이블을 읽으면 42501로 실패합니다(경계 테스트의 import 검사와 별개의 두 번째 겹).
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_SOCIAL_DB_ROLE | `peerchive_social` | 역할 이름. `off`는 개발·테스트 전용(역할 전환 없이 읽음). **production에서는 무시하고 늘 전환합니다(실패하면 요청 실패 = fail closed)** |
 *
 * 운영: 앱 DB 계정이 그 역할의 멤버여야 합니다(`GRANT peerchive_social TO <앱 계정>`, RUNBOOK §2). 역할이 없거나 멤버가 아니면 SET ROLE이 실패해
 * 요청이 500이 됩니다 — 권한 없이 넓게 읽는 쪽으로 물러서지 않습니다.
 *
 * 바깥 트랜잭션(테스트의 rollback 트랜잭션) 안에서 부르면 savepoint가 되므로, 끝나면 `RESET ROLE`로 되돌립니다(실패하면 savepoint rollback이 되돌림).
 */
import { isProductionMode, sql, type DbExecutor } from '@peerchive/db'

export const SOCIAL_DB_ROLE_ENV = 'PEERCHIVE_SOCIAL_DB_ROLE'
const DEFAULT_ROLE = 'peerchive_social'

type Env = Readonly<Record<string, string | undefined>>

let envOverride: Env | null = null
/** 테스트용: 환경 변수 대신 쓸 값(null이면 process.env). */
export function setSocialRoleEnvForTesting(env: Env | null): void {
  envOverride = env
}

function currentEnv(): Env {
  if (envOverride) return envOverride
  const env = (globalThis.process?.env ?? {}) as Env
  return { NODE_ENV: env['NODE_ENV'], [SOCIAL_DB_ROLE_ENV]: env[SOCIAL_DB_ROLE_ENV] }
}

/** 전환할 역할 이름. 개발·테스트에서 `off`면 null. production은 `off`를 받지 않습니다. 이름은 소문자·숫자·밑줄만. */
export function resolveSocialRole(env: Env): string {
  const raw = env[SOCIAL_DB_ROLE_ENV]?.trim() ?? ''
  if (raw === 'off' && !isProductionMode(env)) return ''
  if (raw === '' || raw === 'off' || !/^[a-z_][a-z0-9_]{0,62}$/.test(raw)) return DEFAULT_ROLE
  return raw
}

/** social 역할로 읽기 함수를 실행합니다. 함수 안에서는 쓰기를 하지 마세요(역할에 쓰기 권한이 없음). */
export async function withSocialRole<T>(db: DbExecutor, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  const role = resolveSocialRole(currentEnv())
  return db.transaction(async (tx) => {
    if (!role) return fn(tx)
    await tx.execute(sql.raw(`set local role ${role}`))
    const out = await fn(tx)
    await tx.execute(sql.raw('reset role'))
    return out
  })
}
