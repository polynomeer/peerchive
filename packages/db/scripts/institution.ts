/**
 * 기관·초대 코드 CLI (I-01, ADR 0037). 운영자 API(`/api/v1/operator/institutions`, `/operator/institutions/:id/invite-codes`,
 * `/operator/invite-codes/:id/revoke`)와 같은 규칙입니다. I-02에서 기관 운영진 화면이 생기기 전까지 운영자가 이 명령으로 기관을 만들고 코드를 냅니다.
 *
 *   pnpm --filter @peerchive/db institution create <bootcamp|training_program|club_federation> <이름>
 *   pnpm --filter @peerchive/db institution list [kind]
 *   pnpm --filter @peerchive/db institution issue-code <institutionId> --max-uses=30 [--days=14] [--cohort=12기]
 *   pnpm --filter @peerchive/db institution list-codes <institutionId>
 *   pnpm --filter @peerchive/db institution revoke-code <codeId>
 *
 * - 초대 코드 원문은 issue-code 출력에 **한 번만** 나옵니다. DB에는 HMAC(PEERCHIVE_AFFILIATION_PEPPER, `invite-code:v1:` + 정규 코드)만 저장하므로
 *   웹과 같은 PEERCHIVE_AFFILIATION_PEPPER를 설정하고 실행하세요(다르면 코드가 맞지 않음). production에서 없거나 약하면 실행하지 않습니다.
 * - P2 기능 플래그(PEERCHIVE_FEATURE_P2_INSTITUTIONS)와 무관하게 준비할 수 있지만, 플래그가 꺼져 있으면 사용자는 코드를 쓸 수 없습니다(404).
 * - 만들기·발급·철회는 audit_events에 남깁니다(actor 없음 = 콘솔, metadata는 id·종류·숫자만).
 * DATABASE_URL(없으면 저장소 루트 .env)을 씁니다. Node 22.18+의 TypeScript 타입 제거로 바로 실행합니다(추가 의존성 없음).
 */
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

// 규칙 파일은 다른 파일을 import하지 않으므로 타입 제거로 단독 실행할 수 있습니다.
const rules = (await import(new URL('../../domain/src/institutions.ts', import.meta.url).href)) as typeof import('../../domain/src/institutions')
const ops = (await import(new URL('../src/ops.ts', import.meta.url).href)) as typeof import('../src/ops')

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const argv = process.argv.slice(2)
const positional = argv.filter((arg) => !arg.startsWith('--'))
const flag = (name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const [command, ...rest] = positional
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const usage = () => {
  console.error(
    [
      '사용법:',
      '  institution create <bootcamp|training_program|club_federation> <이름>',
      '  institution list [kind]',
      '  institution issue-code <institutionId> --max-uses=N [--days=14] [--cohort=기수]',
      '  institution list-codes <institutionId>',
      '  institution revoke-code <codeId>',
    ].join('\n'),
  )
  process.exit(2)
}
if (!command || !['create', 'list', 'issue-code', 'list-codes', 'revoke-code'].includes(command)) usage()
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL이 없습니다.')
  process.exit(2)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
const fail = (message: string) => {
  console.error(message)
  process.exitCode = 1
}

async function canonicalInstitution(id: string) {
  const [row] = await sql<{ id: string; name: string; kind: string }[]>`
    select coalesce(c.id, s.id) as id, coalesce(c.name, s.name) as name, coalesce(c.kind, s.kind)::text as kind
    from schools s left join schools c on c.id = s.merged_into where s.id = ${id.toLowerCase()}`
  return row ?? null
}

try {
  if (command === 'create') {
    const [kind, ...nameParts] = rest
    const name = rules.normalizeInstitutionName(nameParts.join(' '))
    if (!kind || !rules.isNonUniversityKind(kind)) fail('종류는 bootcamp·training_program·club_federation 중 하나입니다(대학은 학생이 만드는 학교입니다).')
    else if (!name) fail('이름은 1–80자여야 합니다.')
    else {
      const key = rules.institutionNameKey(name)
      const result = await sql.begin(async (tx) => {
        const [existing] = await tx<{ id: string; kind: string }[]>`select id, kind::text as kind from schools where name_key = ${key} and merged_into is null`
        if (existing) return { existing }
        const [row] = await tx<{ id: string }[]>`insert into schools (name, name_key, kind) values (${name}, ${key}, ${kind}::institution_kind) returning id`
        await tx`
          insert into audit_events (actor_id, action, target_type, target_id, metadata)
          values (null, 'institution.create', 'school', ${row!.id}, ${tx.json({ kind, via: 'cli' })})`
        return { created: row! }
      })
      if ('existing' in result) fail(`같은 이름의 학교·기관이 이미 있습니다: ${result.existing!.id} (${result.existing!.kind})`)
      else console.log(`${name}(${rules.INSTITUTION_KIND_LABELS[kind as 'bootcamp']})을(를) 만들었습니다: ${result.created!.id}`)
    }
  } else if (command === 'list') {
    const kind = rest[0]
    if (kind && !rules.isNonUniversityKind(kind)) fail('종류는 bootcamp·training_program·club_federation 중 하나입니다.')
    else {
      const rows = await sql<{ id: string; name: string; kind: string }[]>`
        select id, name, kind::text as kind from schools
        where merged_into is null and kind <> 'university' ${kind ? sql`and kind = ${kind}::institution_kind` : sql``}
        order by name limit 200`
      if (!rows.length) console.log('(대학이 아닌 기관 없음)')
      for (const r of rows) console.log(`${r.id}  ${r.kind}  ${r.name}`)
    }
  } else if (command === 'issue-code') {
    const institutionId = rest[0]
    if (!institutionId || !UUID.test(institutionId)) usage()
    const pepper = ops.resolvePepper(process.env, ops.AFFILIATION_PEPPER_ENV)
    const checked = rules.checkInviteIssue(
      { maxUses: flag('max-uses') ? Number(flag('max-uses')) : undefined, expiresInDays: flag('days') ? Number(flag('days')) : undefined },
      new Date(),
    )
    const institution = await canonicalInstitution(institutionId!)
    if (!pepper) fail(`${ops.AFFILIATION_PEPPER_ENV}가 없거나 약합니다(웹과 같은 값을 설정하세요. 로컬 개발 DB에서는 NODE_ENV=development로 개발용 값을 씁니다).`)
    else if (!checked.ok) fail(checked.field === 'maxUses' ? '--max-uses는 1–1000 정수입니다(필수).' : '--days는 1–90 정수입니다.')
    else if (!institution) fail('그 기관이 없습니다.')
    else if (!rules.isNonUniversityKind(institution.kind)) fail('대학은 학교 메일로만 인증합니다. 대학이 아닌 기관을 고르세요.')
    else {
      const cohortRaw = flag('cohort')
      const cohort = cohortRaw === undefined ? null : rules.normalizeCohortLabel(cohortRaw)
      if (cohort && !cohort.ok) fail('--cohort는 1–20자입니다.')
      else {
        const code = rules.generateInviteCode()
        const normalized = rules.normalizeInviteCode(code)!
        const codeHash = createHmac('sha256', pepper).update(rules.inviteCodeHashMessage(normalized)).digest('hex')
        const row = await sql.begin(async (tx) => {
          let cohortId: string | null = null
          if (cohort?.ok) {
            await tx`insert into institution_cohorts (school_id, label, label_key) values (${institution.id}, ${cohort.value}, ${cohort.key})
              on conflict (school_id, label_key) do nothing`
            const [c] = await tx<{ id: string }[]>`select id from institution_cohorts where school_id = ${institution.id} and label_key = ${cohort.key}`
            cohortId = c!.id
          }
          const [inserted] = await tx<{ id: string; expires_at: Date }[]>`
            insert into institution_invite_codes (school_id, cohort_id, code_hash, issued_by, expires_at, max_uses)
            values (${institution.id}, ${cohortId}, ${codeHash}, null, ${checked.expiresAt}, ${checked.maxUses}) returning id, expires_at`
          await tx`
            insert into audit_events (actor_id, action, target_type, target_id, metadata)
            values (null, 'invite_code.issue', 'invite_code', ${inserted!.id},
              ${tx.json({ schoolId: institution.id, cohort: cohortId !== null, maxUses: checked.maxUses, via: 'cli' })})`
          return inserted!
        })
        console.log(`${institution.name} 초대 코드(이 출력에만 보입니다): ${code}`)
        console.log(`id ${row.id} · 사용 한도 ${checked.maxUses}회 · ${row.expires_at.toISOString()}까지${cohort?.ok ? ` · 기수 ${cohort.value}` : ''}`)
      }
    }
  } else if (command === 'list-codes') {
    const institutionId = rest[0]
    if (!institutionId || !UUID.test(institutionId)) usage()
    const institution = await canonicalInstitution(institutionId!)
    if (!institution) fail('그 기관이 없습니다.')
    else {
      const rows = await sql<{ id: string; label: string | null; expires_at: Date; max_uses: number; used_count: number; revoked_at: Date | null }[]>`
        select k.id, c.label, k.expires_at, k.max_uses, k.used_count, k.revoked_at
        from institution_invite_codes k left join institution_cohorts c on c.id = k.cohort_id
        where k.school_id = ${institution.id} order by k.created_at desc limit 100`
      if (!rows.length) console.log(`${institution.name}: (초대 코드 없음)`)
      for (const r of rows) {
        const state = r.revoked_at ? '철회' : r.expires_at.getTime() <= Date.now() ? '만료' : r.used_count >= r.max_uses ? '소진' : '유효'
        console.log(`${r.id}  ${state}  ${r.used_count}/${r.max_uses}  ${r.expires_at.toISOString()}${r.label ? `  ${r.label}` : ''}`)
      }
    }
  } else if (command === 'revoke-code') {
    const codeId = rest[0]
    if (!codeId || !UUID.test(codeId)) usage()
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string; school_id: string; revoked_at: Date | null }[]>`
        select id, school_id, revoked_at from institution_invite_codes where id = ${codeId!.toLowerCase()} for update`
      if (!row) return 'not_found' as const
      if (row.revoked_at) return 'already' as const
      await tx`update institution_invite_codes set revoked_at = now() where id = ${row.id}`
      await tx`
        insert into audit_events (actor_id, action, target_type, target_id, metadata)
        values (null, 'invite_code.revoke', 'invite_code', ${row.id}, ${tx.json({ schoolId: row.school_id, via: 'cli' })})`
      return 'revoked' as const
    })
    if (result === 'not_found') fail('그 초대 코드가 없습니다.')
    else console.log(result === 'revoked' ? '철회했습니다. 이미 이 코드로 인증한 소속은 그대로입니다.' : '이미 철회된 코드입니다.')
  }
} finally {
  await sql.end()
}
