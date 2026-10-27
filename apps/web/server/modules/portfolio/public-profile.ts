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
 *
 * 페르소나(S-01, ADR 0028): handle은 실명·표시명 페르소나 어느 쪽이든 됩니다. 프로필 필드·지금 판은 그 페르소나의 것입니다.
 * - **표시명 페르소나**에는 프로필 필드·판의 글(한 줄 소개·역량 이름·스킬)·본인이 켠 학교 인증 배지만 싣습니다. 대표 케이스·4년 타임라인·
 *   후배 기여는 계정 단위 기록(공개 사례에 계정 표시 이름이 있음)이라 비워 둡니다 — 이것만으로도 두 프로필이 이어지기 때문입니다.
 * - 상대 페르소나는 `linkedPersona` 한 필드에만, 연결 플래그가 켜져 있을 때만(`canSeeIdentityLink`, 공개 경로는 늘 "본인 아님") 싣습니다.
 *   꺼져 있으면 상대 페르소나의 handle·이름·id·소개가 이 DTO(그리고 이것만 그리는 HTML·OG·인쇄 보기·README 카드)에 없습니다.
 *
 * 과제 수행 목록(S-03, ADR 0031): `projects`는 `canViewPersonaItem('project_list')`를 비로그인으로 판정해 통과할 때만(전체 공개) 싣습니다.
 * 공개 사례·타임라인은 공개 범위 설정과 무관하게 공개 절차를 거친 것만입니다(설정으로 넓힐 수 없음, §8.3 불변조건 2).
 */
import { ANONYMOUS_VIEWER, CASE_SECTIONS, clipText } from '@peerchive/domain'
import {
  and,
  caseStudies,
  eq,
  inArray,
  ne,
  planForks,
  seniorNotes,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { toPublicProfileDto } from '../identity/profile-input'
import { publicAffiliationBadges } from '../affiliation/affiliations'
import { linkedPersonaFor, resolvePublicPersona } from '../social/personas'
import { visiblePersonaProjects } from '../social/visibility'
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

/** 공개 프로필(그 페르소나의 지금 판 기준). 없는 handle·비활성 사용자·운영 조치로 숨긴 프로필(T-15)은 404. */
export async function getPublicPortfolioProfile(db: DbExecutor, rawHandle: unknown, now = new Date()): Promise<PublicPortfolioProfileDto> {
  const { persona, profile, displayName } = await resolvePublicPersona(db, rawHandle)
  const userId = persona.userId
  const isReal = persona.kind === 'real'
  const base = toPublicProfileDto({ displayName }, profile)
  const current = await loadCurrentEditionModel(db, persona.id)
  const model = current?.model ?? { userId, headline: null, featured: [], competencies: [], evidence: [], skillsDeclared: [] }
  // 표시명 판은 대표 케이스를 받지 않지만(editions.ts), 읽을 때도 한 번 더 비웁니다.
  const view = await buildPortfolioView(db, isReal ? model : { ...model, featured: [], evidence: [] }, now)

  // 게시한 케이스 스터디(지금 제공 가능)의 공개들: 타임라인·포크 수. 실명 페르소나만.
  const published = isReal
    ? (await loadCaseStudiesWithRelease(db, and(eq(caseStudies.userId, userId), eq(caseStudies.status, 'published')), now)).filter(isPubliclyVisible)
    : []
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
        .where(and(inArray(planForks.sourcePublicationId, publicationIds), ne(planForks.forkedBy, userId)))
    : []
  const [{ notes } = { notes: 0 }] = isReal
    ? await db
        .select({ notes: sql<number>`count(*)::int` })
        .from(seniorNotes)
        .where(and(eq(seniorNotes.authorId, userId), eq(seniorNotes.status, 'published'), eq(seniorNotes.displayMode, 'name')))
    : []

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
    // 학교 인증 배지(C-01): 본인이 켰을 때만. 학과·메일·도메인은 싣지 않습니다.
    affiliationBadges: await publicAffiliationBadges(db, userId, profile.showAffiliationBadge),
    kind: persona.kind,
    linkedPersona: await linkedPersonaFor(db, persona, { isOwner: false }),
    // 과제 수행 목록(S-03): 공개 경로는 늘 비로그인으로 판정 — `project_list`가 전체 공개일 때만. 과목·학기·제목뿐, 엠바고 중이면 제목 없음.
    projects: await visiblePersonaProjects(db, persona, ANONYMOUS_VIEWER, now),
  }
}

/** 마크다운에서 링크·강조로 해석될 글자를 막습니다(제목·요약은 사용자·스냅샷 글). */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/([\\`*_{}[\]()<>#+!|~-])/g, '\\$1')
}

/**
 * GitHub 프로필 README용 마크다운 카드(§10.6). 공개 프로필과 같은 데이터만: 이름·한 줄 소개, 볼 수 있는 대표 케이스의 제목과 한 줄 요약
 * (첫 "문제와 결과" 문장), 공개 프로필·사례 링크, 연결을 켠 상대 페르소나 링크(S-01), 전체 공개한 과제 수행 목록(S-03). 볼 수 없는 케이스는 빼고,
 * 이메일·id는 없습니다.
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
  // 과제 수행 목록(S-03): 공개 DTO에 있을 때만(전체 공개). 과목·학기·제목, 엠바고 중이면 제목 없이.
  const listed = profile.projects ?? []
  if (listed.length) {
    lines.push('과제 수행 목록:')
    for (const p of listed) {
      const parts = [p.courseTitle, p.termLabel, p.title].filter((x): x is string => !!x).map((x) => escapeMarkdown(x))
      lines.push(`- ${parts.length ? parts.join(' · ') : '과목 미연결 과제'}${p.title === null ? ' (제목 비공개 기간)' : ''}`)
    }
    lines.push('')
  }
  // 연결 플래그가 켜져 있을 때만(공개 DTO에 linkedPersona가 있을 때만) 상대 프로필 링크를 붙입니다(S-01).
  const linked = profile.linkedPersona
  if (linked) lines.push(`${linked.kind === 'real' ? '실명 프로필' : '표시명 프로필'}: [${escapeMarkdown(linked.displayName)} @${linked.handle}](${base}/u/${linked.handle})`, '')
  lines.push(`[전체 포트폴리오 보기](${base}/u/${profile.handle}) · 모든 문장에 공개 기록 출처가 붙어 있습니다.`, '')
  return lines.join('\n')
}

