/**
 * 토픽 CLI (A-05, ADR 0042). 운영자 API(`POST /api/v1/operator/community/topics`)와 같은 규칙으로 학교를 넘나드는 토픽을 만듭니다.
 *
 *   pnpm --filter @peerchive/db topic create <career|grad_school|startup|military|campus_life|role> <이름> [--description=소개]
 *   pnpm --filter @peerchive/db topic list
 *
 * - 토픽 = community_spaces(kind topic, 학교 없음, 이름 표시 affiliated_anonymous 고정, listed·open, 정원 100000) + 게시판 하나(`게시판`, general).
 *   같은 이름 키(@peerchive/domain labelKey: NFKC·소문자·문자/숫자/+#만)의 토픽이 있으면 만들지 않습니다(advisory lock 안에서 확인).
 * - P2 기능 플래그(PEERCHIVE_FEATURE_P2_TOPICS)와 무관하게 준비할 수 있지만, 플래그가 꺼져 있으면 사용자에게는 404입니다.
 * - 만들기는 audit_events에 남깁니다(actor 없음 = 콘솔, metadata는 종류·분류만).
 * - 이 파일은 다른 TypeScript 파일을 import하지 않습니다(Node 타입 제거로 바로 실행). 분류·이름 규칙은 @peerchive/domain(affiliation-labels.ts
 *   TOPIC_CATEGORIES, community.ts checkSpaceName·SPACE_NAME_MAX, courses.ts labelKey)과 같게 유지하세요.
 * DATABASE_URL(없으면 저장소 루트 .env)을 씁니다.
 */
import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const TOPIC_CATEGORIES = ['career', 'grad_school', 'startup', 'military', 'campus_life', 'role'] as const
const SPACE_NAME_MAX = 40
const SPACE_DESCRIPTION_MAX = 300
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

const labelKey = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, '')
const normalize = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim()
const slug = (): string => Array.from({ length: 10 }, () => SLUG_ALPHABET[randomInt(0, SLUG_ALPHABET.length)]).join('')

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const argv = process.argv.slice(2)
const positional = argv.filter((arg) => !arg.startsWith('--'))
const flag = (name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const [command, ...rest] = positional
const usage = () => {
  console.error(['사용법:', `  topic create <${TOPIC_CATEGORIES.join('|')}> <이름> [--description=소개]`, '  topic list'].join('\n'))
  process.exit(2)
}
if (!command || !['create', 'list'].includes(command)) usage()
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

try {
  if (command === 'create') {
    const [category, ...nameParts] = rest
    const name = normalize(nameParts.join(' '))
    const description = flag('description') === undefined ? null : normalize(flag('description')!) || null
    // eslint-disable-next-line no-control-regex
    const control = /[\u0000-\u001f\u007f]/
    if (!category || !(TOPIC_CATEGORIES as readonly string[]).includes(category)) fail(`분류는 ${TOPIC_CATEGORIES.join('·')} 중 하나입니다.`)
    else if (!name || [...name].length > SPACE_NAME_MAX || control.test(name)) fail(`이름은 1–${SPACE_NAME_MAX}자여야 합니다.`)
    else if (description && [...description].length > SPACE_DESCRIPTION_MAX) fail(`소개는 ${SPACE_DESCRIPTION_MAX}자 이하입니다.`)
    else {
      const key = labelKey(name)
      const result = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${'topic:' + key}))`
        const topics = await tx<{ slug: string; name: string }[]>`select slug, name from community_spaces where kind = 'topic'`
        const same = topics.find((t) => labelKey(t.name) === key)
        if (same) return { existing: same }
        const [op] = await tx<{ id: string }[]>`select user_id as id from operators where revoked_at is null order by granted_at limit 1`
        if (!op) return { noOperator: true as const }
        const [row] = await tx<{ id: string; slug: string }[]>`
          insert into community_spaces (kind, school_id, name, description, slug, current_name_mode, topic_category, discovery, join_policy, capacity, created_by)
          values ('topic', null, ${name}, ${description}, ${slug()}, 'affiliated_anonymous', ${category}::topic_category, 'listed', 'open', 100000, ${op.id})
          returning id, slug`
        await tx`insert into boards (space_id, kind, title, write_role, position) values (${row!.id}, 'general', '게시판', 'member', 0)`
        await tx`
          insert into audit_events (actor_id, action, target_type, target_id, metadata)
          values (null, 'community.topic_create', 'community_space', ${row!.id}, ${tx.json({ kind: 'topic', category, via: 'cli' })})`
        return { created: row! }
      })
      if ('existing' in result) fail(`같은 이름의 토픽이 이미 있습니다: /community/s/${result.existing!.slug}`)
      else if ('noOperator' in result) fail('운영자 계정이 없습니다(토픽의 created_by). 먼저 grant-operator로 운영자를 지정하세요.')
      else console.log(`토픽 ${name}(${category})을(를) 만들었습니다: /community/s/${result.created!.slug}`)
    }
  } else if (command === 'list') {
    const rows = await sql<{ slug: string; name: string; category: string; status: string }[]>`
      select slug, name, topic_category::text as category, status::text as status from community_spaces where kind = 'topic' order by topic_category, name limit 200`
    if (!rows.length) console.log('(토픽 없음)')
    for (const r of rows) console.log(`${r.slug}  ${r.category}  ${r.status}  ${r.name}`)
  }
} finally {
  await sql.end()
}
