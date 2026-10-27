/**
 * schema.ts의 커뮤니티 구역(`// ── …커뮤니티…`)에 있는 테이블 SQL 이름(C-05 경계 검사와 같은 규칙, ADR 0021). C-07 테스트의 센티넬 검사가 씁니다.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SCHEMA = join(resolve(__dirname, '../../..'), 'packages/db/src/schema.ts')

function communityTables(): Set<string> {
  const out = new Set<string>()
  let community = false
  for (const chunk of readFileSync(SCHEMA, 'utf8').split(/\n(?=\/\/ ── )/)) {
    const header = chunk.split('\n', 1)[0] ?? ''
    if (header.startsWith('// ── ')) community = header.includes('커뮤니티')
    if (!community) continue
    for (const m of chunk.matchAll(/export const \w+ = pgTable\(\s*'([a-z0-9_]+)'/g)) out.add(m[1]!)
  }
  return out
}

export const COMMUNITY_TABLE_SQL: ReadonlySet<string> = communityTables()
