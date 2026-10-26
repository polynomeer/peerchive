/**
 * 학교 메일 도메인 등록·삭제 CLI (C-01, ADR 0018). 운영자 API(`/api/v1/operator/schools/:id/email-domains`)와 같은 규칙입니다.
 * 파일럿 전에 운영자가 학교마다 메일 도메인을 등록해야 그 학교 학생이 학교 메일로 인증하고 과목 허브에 쓸 수 있습니다.
 *
 *   pnpm --filter @peerchive/db school-email-domain list <schoolId>
 *   pnpm --filter @peerchive/db school-email-domain add <schoolId> <domain>      # 예: yu.ac.kr (하위 도메인 stu.yu.ac.kr도 인정)
 *   pnpm --filter @peerchive/db school-email-domain remove <schoolId> <domain>   # 이미 인증된 소속은 그대로
 *
 * DATABASE_URL(없으면 저장소 루트 .env)을 씁니다. 병합된 학교 id면 정본 학교에 붙입니다. 도메인은 @peerchive/domain의 규칙으로 정규화·검사합니다
 * (TLD 하나·공용 접미사(ac.kr 등)·웹메일 거부, 한 도메인은 한 학교, 다른 학교 도메인의 상위·하위 도메인 거부).
 * 등록·삭제는 audit_events에 남깁니다(actor 없음 = 콘솔). Node 22.18+의 TypeScript 타입 제거로 바로 실행합니다(추가 의존성 없음).
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

// 도메인 규칙 파일은 다른 파일을 import하지 않으므로 타입 제거로 단독 실행할 수 있습니다.
const rules = (await import(new URL('../../domain/src/affiliation.ts', import.meta.url).href)) as typeof import('../../domain/src/affiliation')

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const [command, schoolArg, domainArg] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const usage = () => {
  console.error('사용법: school-email-domain list <schoolId> | add <schoolId> <domain> | remove <schoolId> <domain>')
  process.exit(2)
}
if (!command || !['list', 'add', 'remove'].includes(command) || !schoolArg || !UUID.test(schoolArg)) usage()
if (command !== 'list' && !domainArg) usage()
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL이 없습니다.')
  process.exit(2)
}

const REASONS: Record<string, string> = {
  invalid: '도메인 형식이 올바르지 않습니다.',
  shared_suffix: '공용 접미사(ac.kr 등)는 학교 도메인으로 등록할 수 없습니다.',
  webmail: '웹메일 도메인은 학교 도메인으로 등록할 수 없습니다.',
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
try {
  const [school] = await sql<{ id: string; name: string }[]>`
    select coalesce(c.id, s.id) as id, coalesce(c.name, s.name) as name
    from schools s left join schools c on c.id = s.merged_into
    where s.id = ${schoolArg!.toLowerCase()}`
  if (!school) {
    console.error('그 학교가 없습니다.')
    process.exitCode = 1
  } else if (command === 'list') {
    const rows = await sql<{ domain: string }[]>`
      select d.domain from school_email_domains d join schools s on s.id = d.school_id
      where s.id = ${school.id} or s.merged_into = ${school.id} order by d.domain`
    console.log(`${school.name}: ${rows.length ? rows.map((r) => r.domain).join(', ') : '(등록된 도메인 없음)'}`)
  } else {
    const checked = rules.checkSchoolDomain(domainArg!)
    if (!checked.ok) {
      console.error(REASONS[checked.reason])
      process.exitCode = 1
    } else {
      const domain = checked.domain
      const result = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('school-email-domains'))`
        const all = await tx<{ id: string; domain: string; owner: string }[]>`
          select d.id, d.domain, coalesce(s.merged_into, s.id) as owner from school_email_domains d join schools s on s.id = d.school_id`
        const same = all.find((r) => r.domain === domain)
        if (command === 'remove') {
          if (!same || same.owner !== school.id) return 'not_found' as const
          await tx`delete from school_email_domains where id = ${same.id}`
          await tx`
            insert into audit_events (actor_id, action, target_type, target_id, metadata)
            values (null, 'school_email_domain.remove', 'school', ${school.id}, ${tx.json({ domain, domainId: same.id, via: 'cli' })})`
          return 'removed' as const
        }
        if (same) return same.owner === school.id ? ('exists' as const) : ('taken' as const)
        if (all.some((r) => r.owner !== school.id && (rules.schoolDomainMatches(domain, r.domain) || rules.schoolDomainMatches(r.domain, domain)))) {
          return 'overlaps' as const
        }
        const [row] = await tx<{ id: string }[]>`
          insert into school_email_domains (school_id, domain, added_by) values (${school.id}, ${domain}, null) returning id`
        await tx`
          insert into audit_events (actor_id, action, target_type, target_id, metadata)
          values (null, 'school_email_domain.add', 'school', ${school.id}, ${tx.json({ domain, domainId: row!.id, via: 'cli' })})`
        return 'added' as const
      })
      const messages = {
        added: `${school.name}에 ${domain}을(를) 등록했습니다.`,
        exists: `${school.name}에 이미 ${domain}이(가) 있습니다.`,
        removed: `${school.name}에서 ${domain}을(를) 지웠습니다. 이미 인증된 소속은 그대로입니다.`,
        taken: `${domain}은(는) 다른 학교에 등록되어 있습니다.`,
        overlaps: `${domain}은(는) 다른 학교 도메인과 겹칩니다(상위·하위 도메인).`,
        not_found: `${school.name}에 ${domain}이(가) 없습니다.`,
      } as const
      console.log(messages[result])
      if (result === 'taken' || result === 'overlaps' || result === 'not_found') process.exitCode = 1
    }
  }
} finally {
  await sql.end()
}
