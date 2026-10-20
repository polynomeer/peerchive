/**
 * 주간 기여 요약 문장 (pilot-kit-e0 §4.1 양식, T-08). 디스코드 봇(T-09)이 팀 채널에 보낼 본문입니다.
 *
 * - 순수 함수: 장부 DTO(ledger.ts)만 받아 문자열을 만듭니다(DB·시각 접근 없음).
 * - 점수·비율·순위를 만들지 않습니다. 멤버는 장부 순서(이름순) 그대로이고, 개수가 0인 종류는 적지 않습니다.
 * - 선언 상태는 글자로: `팀원 확인 N명` / `이의 있음` / `본인 설명 · 미확인`.
 * - 마지막 줄은 항상 "※ 개수는 참고용이며 기여의 크기를 뜻하지 않습니다."입니다.
 * - 이메일·내부 id를 넣지 않습니다(이름과 선언 문장, 막힘 요약만).
 */
import {
  CONTRIBUTION_DISCLAIMER,
  type ClaimDto,
  type ContributionDto,
  type LedgerMemberDto,
  type LogTag,
} from '../../../shared/types/api'

/** 요약에 쓰는 태그 이름(pilot-kit 표기). */
export const SUMMARY_TAG_LABELS: Record<LogTag, string> = {
  progress: '🔨진행',
  stuck: '🧱막힘',
  solution: '💡해결',
  decision: '⚖️결정',
  meeting: '🗣️회의 정리',
  validation: '✅검증',
  retro: '🔁회고',
}

const TAG_ORDER: LogTag[] = ['progress', 'stuck', 'solution', 'decision', 'meeting', 'validation', 'retro']

/** 미해결 막힘을 몇 개까지 줄로 적을지. 나머지는 "외 N건". */
export const SUMMARY_UNRESOLVED_MAX = 5

const INDENT = '     '

/** MM-DD */
const monthDay = (date: string) => date.slice(5, 10)

export function claimStatusText(claim: Pick<ClaimDto, 'status' | 'confirmedCount'>): string {
  if (claim.status === 'disputed') return '이의 있음'
  if (claim.status === 'confirmed') return `팀원 확인 ${claim.confirmedCount}명`
  return '본인 설명 · 미확인'
}

/** 한 멤버의 활동 줄("🔨진행 2 · 🧱막힘 1(해결 1) · …"). 기록이 없으면 "기록 없음". */
export function memberActivityLine(row: Omit<LedgerMemberDto, 'member' | 'active' | 'claims'>): string {
  const parts: string[] = []
  for (const tag of TAG_ORDER) {
    const n = row.logCounts[tag]
    if (!n) continue
    parts.push(tag === 'stuck' && row.stuckResolved > 0 ? `${SUMMARY_TAG_LABELS[tag]} ${n}(해결 ${row.stuckResolved})` : `${SUMMARY_TAG_LABELS[tag]} ${n}`)
  }
  if (row.tasksCompleted) parts.push(`☑️할 일 완료 ${row.tasksCompleted}`)
  if (row.artifactsUploaded) parts.push(`📎파일 ${row.artifactsUploaded}`)
  if (row.meetingsAttended) parts.push(`👥회의 참석 ${row.meetingsAttended}`)
  return parts.length > 0 ? parts.join(' · ') : '기록 없음'
}

const quote = (text: string) => `“${text.replace(/\s+/g, ' ').trim()}”`

export function formatWeeklySummary(data: ContributionDto): string {
  const range = `${monthDay(data.period.from)} ~ ${monthDay(data.period.to)}`
  const lines: string[] = [
    data.period.weekNo !== null
      ? `[${data.project.title}] 주간 기여 요약 — ${data.period.weekNo}주차 (${range})`
      : `[${data.project.title}] 기여 요약 (${range})`,
  ]
  if (data.milestone) {
    const due = data.milestone.dueAt ? `예정 ${monthDay(data.milestone.dueAt)}` : '예정일 없음'
    const snaps = data.milestone.snapshotsInPeriod > 0 ? ` — 스냅샷 ${data.milestone.snapshotsInPeriod}개 등록` : ''
    lines.push(`마일스톤: ${data.milestone.title} (${due})${snaps}`)
  }
  lines.push('')

  if (data.members.length === 0) lines.push('멤버 없음')
  for (const row of data.members) {
    const name = row.member.displayName || '이름 미설정'
    lines.push(`${name}${row.active ? '' : '(나간 멤버)'}  ${memberActivityLine(row)}`)
    if (row.claims.length === 0) lines.push(`${INDENT}역할 선언 없음`)
    for (const claim of row.claims) lines.push(`${INDENT}역할 선언 ${quote(claim.text)} — ${claimStatusText(claim)}`)
  }

  const shown = data.unresolvedStuck.slice(0, SUMMARY_UNRESOLVED_MAX)
  for (const stuck of shown) {
    lines.push(`미해결 막힘: ${quote(stuck.summary)} (${stuck.author.displayName || '이름 미설정'}, ${stuck.openDays}일째)`)
  }
  const rest = data.unresolvedStuck.length - shown.length
  if (rest > 0) lines.push(`미해결 막힘 외 ${rest}건`)

  lines.push('', CONTRIBUTION_DISCLAIMER)
  return lines.join('\n')
}
