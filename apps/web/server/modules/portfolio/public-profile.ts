/**
 * 익명 공개 프로필·README 카드 (T-14, PROOFU_EVOLUTION_PLAN §10.1·§10.6·§11·§13.2, DELIVERY_PLAN 시나리오 I, ADR 0012·0014).
 *
 * `GET /api/v1/public/profiles/:handle`(로그인 불필요, 쿠키 없음, no-store, noindex 기본, 운영 스위치 503 — 공개 조회 공통 handler).
 * 출처(이것 말고는 읽지 않음):
 * - 프로필의 공개 필드(T-02 공개 DTO와 같은 허용 목록: 이름·한 줄 소개·관심 직무·학교/졸업(본인 입력)·연락 정책·구직 여부). 이메일·id 없음.
 * - 지금 판(current)만: 판의 사용자 글, 대표 케이스(게시 중 + 고정 release 제공 가능할 때만 글, 아니면 안내만), 매트릭스.
 * - 4년 타임라인: 이 사람이 **게시한** 케이스 스터디의 release 중 지금 제공 가능한 것(공개 제목·학기 표시·사례 링크). 익명이던 release는
 *   본인이 연결을 확인하고(reveal_self) 게시한 케이스가 있을 때만 나옵니다.
 * - 후배 기여: 위 공개들의 계획을 포크한 서로 다른 사람 수(본인 제외), 계정 이름으로 게시한 선배 노트 수. 개수만, 순위 없음.
 *   익명·표시명 선배 노트는 실명 프로필과 연결하지 않으려고 세지 않습니다.
 * 연락: 이메일을 싣지 않고 연락 정책 안내 문구만(연락 요청 기능은 P2).
 */
import { CASE_SECTIONS, clipText } from '@peerchive/domain'
import {
  and,
  caseStudies,
  eq,
  inArray,
  ne,
  planForks,
  profiles,
  seniorNotes,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { notFound } from '../errors'
import { HANDLE_PATTERN, toPublicProfileDto } from '../identity/profiles'
import { loadCurrentEditionModel } from './editions'
import { loadCaseStudiesWithRelease } from './release-scope'
import { buildPortfolioView, isPubliclyVisible } from './view'
import type { ContactPolicy, PublicPortfolioProfileDto, PublicTimelineItemDto } from '../../../shared/types/api'

export const CONTACT_POLICY_TEXT: Readonly<Record<ContactPolicy, string>> = {
  closed: '연락을 받지 않습니다.',
  on_request: '연락 요청을 검토합니다. 연락 요청 기능은 준비 중입니다.',
  open: '연락을 받습니다. 연락 요청 기능은 준비 중입니다.',
}

const SEMESTER_ORDER: Readonly<Record<string, number>> = { spring: 1, summer: 2, fall: 3, winter: 4 }

/** 공개 프로필(지금 판 기준). 없는 handle·비활성 사용자는 404. */
export async function getPublicPortfolioProfile(db: DbExecutor, rawHandle: unknown, now = new Date()): Promise<PublicPortfolioProfileDto> {
  const handle = typeof rawHandle === 'string' ? rawHandle.trim().toLowerCase() : ''
  if (!HANDLE_PATTERN.test(handle) || handle.length > 30) throw notFound()
  const [row] = await db
    .select({ userId: users.id, displayName: users.displayName, profile: profiles })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(profiles.handle, handle), eq(users.status, 'active')))
    .limit(1)
  if (!row) throw notFound()
  const base = toPublicProfileDto(row, row.profile)
  const current = await loadCurrentEditionModel(db, row.userId)
  const view = await buildPortfolioView(
    db,
    current?.model ?? { userId: row.userId, headline: null, featured: [], competencies: [], evidence: [], skillsDeclared: [] },
    now,
  )

  // 게시한 케이스 스터디(지금 제공 가능)의 공개들: 타임라인·포크 수.
  const published = (await loadCaseStudiesWithRelease(db, and(eq(caseStudies.userId, row.userId), eq(caseStudies.status, 'published')), now)).filter(
    isPubliclyVisible,
  )
  const byPublication = new Map<string, (typeof published)[number]>()
  for (const p of published) if (!byPublication.has(p.caseStudy.publicationId)) byPublication.set(p.caseStudy.publicationId, p)
  const timeline: Array<PublicTimelineItemDto & { sort: [number, number, number] }> = [...byPublication.values()].map((p) => {
    const course = p.snapshot.course
    const year = course?.year ?? (p.releasePublishedAt ?? now).getUTCFullYear()
    return {
      termLabel: p.termLabel,
      year,
      title: clipText(p.snapshot.title, 80),
      path: `/p/${p.slug}`,
      sort: [year, course ? (SEMESTER_ORDER[course.semester] ?? 0) : 9, p.releasePublishedAt?.getTime() ?? 0],
    }
  })
  timeline.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2])

  const publicationIds = [...byPublication.keys()]
  const [{ forks } = { forks: 0 }] = publicationIds.length
    ? await db
        .select({ forks: sql<number>`count(distinct ${planForks.forkedBy})::int` })
        .from(planForks)
        .where(and(inArray(planForks.sourcePublicationId, publicationIds), ne(planForks.forkedBy, row.userId)))
    : []
  const [{ notes } = { notes: 0 }] = await db
    .select({ notes: sql<number>`count(*)::int` })
    .from(seniorNotes)
    .where(and(eq(seniorNotes.authorId, row.userId), eq(seniorNotes.status, 'published'), eq(seniorNotes.displayMode, 'name')))

  return {
    handle: base.handle,
    displayName: base.displayName,
    jobTargets: base.jobTargets,
    schoolLabel: base.schoolLabel,
    gradTerm: base.gradTerm,
    contactPolicy: base.contactPolicy,
    contactText: CONTACT_POLICY_TEXT[base.contactPolicy],
    openToWork: base.openToWork,
    ...view,
    headline: view.headline ?? base.headline,
    edition: current ? { version: current.edition.version, createdAt: current.edition.createdAt.toISOString() } : null,
    juniorContribution: { planForks: forks, seniorNotes: notes },
    timeline: timeline.map(({ sort: _sort, ...item }) => item),
  }
}

/** 마크다운에서 링크·강조로 해석될 글자를 막습니다(제목·요약은 사용자·스냅샷 글). */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/([\\`*_{}[\]()<>#+!|~-])/g, '\\$1')
}

/**
 * GitHub 프로필 README용 마크다운 카드(§10.6). 공개 프로필과 같은 데이터만: 이름·한 줄 소개, 볼 수 있는 대표 케이스의 제목과 한 줄 요약
 * (첫 "문제와 결과" 문장), 공개 프로필·사례 링크. 볼 수 없는 케이스는 빼고, 이메일·id는 없습니다.
 */
export function formatReadmeCard(profile: PublicPortfolioProfileDto, origin: string): string {
  const base = origin.replace(/\/+$/, '')
  const lines = [`### ${escapeMarkdown(profile.displayName)} · Peerchive 포트폴리오`, '']
  if (profile.headline) lines.push(escapeMarkdown(clipText(profile.headline, 120)), '')
  const cases = profile.featured.filter((f) => f.available)
  for (const c of cases) {
    if (!c.available) continue
    const first = c.sections.find((s) => s.key === CASE_SECTIONS[0])?.sentences[0]?.text ?? c.sections[0]?.sentences[0]?.text ?? ''
    const summary = first ? ` — ${escapeMarkdown(clipText(first, 100))}` : ''
    lines.push(`- [${escapeMarkdown(c.title)}](${base}${c.path})${summary}`)
  }
  if (cases.length) lines.push('')
  lines.push(`[전체 포트폴리오 보기](${base}/u/${profile.handle}) · 모든 문장에 공개 기록 출처가 붙어 있습니다.`, '')
  return lines.join('\n')
}

