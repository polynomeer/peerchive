/**
 * 운영자 부여·회수 CLI (T-10, ADR 0010). 운영자 권한은 API로 바꿀 수 없고 이 스크립트로만 바꿉니다.
 *
 *   pnpm --filter @peerchive/db grant-operator <email>            # 부여(이미 운영자면 그대로)
 *   pnpm --filter @peerchive/db grant-operator <email> --revoke   # 회수
 *
 * DATABASE_URL(없으면 저장소 루트 .env)을 씁니다. 사용자는 로그인한 적이 있어야 합니다(이메일은 대소문자 무시).
 * 부여·회수는 audit_events에 남깁니다(actor 없음 = 콘솔). 운영자는 비공개 과제 공간을 읽을 수 없습니다.
 * Node 22.18+의 TypeScript 타입 제거로 바로 실행합니다(추가 의존성 없음).
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const args = process.argv.slice(2)
const revoke = args.includes('--revoke')
const email = args.find((arg) => !arg.startsWith('--'))?.trim().toLowerCase()

if (!email || !email.includes('@')) {
  console.error('사용법: grant-operator <email> [--revoke]')
  process.exit(2)
}
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL이 없습니다.')
  process.exit(2)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
try {
  const result = await sql.begin(async (tx) => {
    const [user] = await tx<{ id: string }[]>`
      select u.id from users u
      where lower(u.private_email) = ${email} and u.status = 'active'
      limit 1`
    if (!user) return 'user_not_found' as const
    if (revoke) {
      const rows = await tx`
        update operators set revoked_at = now() where user_id = ${user.id} and revoked_at is null returning user_id`
      if (rows.length === 0) return 'not_operator' as const
    } else {
      const rows = await tx`
        insert into operators (user_id, granted_at, granted_by, revoked_at) values (${user.id}, now(), null, null)
        on conflict (user_id) do update set granted_at = now(), granted_by = null, revoked_at = null
        where operators.revoked_at is not null
        returning user_id`
      if (rows.length === 0) return 'already_operator' as const
    }
    await tx`
      insert into audit_events (actor_id, action, target_type, target_id, metadata)
      values (null, ${revoke ? 'operator.revoke' : 'operator.grant'}, 'operator', ${user.id}, ${tx.json({ via: 'cli' })})`
    return revoke ? ('revoked' as const) : ('granted' as const)
  })
  const messages = {
    granted: '운영자로 지정했습니다.',
    revoked: '운영자 권한을 회수했습니다.',
    already_operator: '이미 운영자입니다.',
    not_operator: '운영자가 아닙니다.',
    user_not_found: '그 이메일의 활성 사용자가 없습니다(먼저 로그인해야 합니다).',
  } as const
  console.log(messages[result])
  if (result === 'user_not_found') process.exitCode = 1
} finally {
  await sql.end()
}
