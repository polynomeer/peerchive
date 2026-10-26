/**
 * 과목 허브·선배 노트·플랜 포크·유용성 신호·검색 색인 규칙 (T-13, PROOFU_EVOLUTION_PLAN §3.1·§8.2–§8.6, SYSTEM_DESIGN §6.2·§11,
 * DELIVERY_PLAN T-13 "공개 release만 노출, 포크는 계획 요소만 복사", 시나리오 F, ADR 0013).
 *
 * - 이 파일의 함수는 모두 **공개 release 스냅샷**(또는 게시된 선배 노트)만 입력으로 받습니다. 비공개 작업 테이블을 보지 않습니다.
 *   스냅샷 타입은 웹의 PublicSnapshot과 같은 모양의 필요한 부분만 구조적으로 선언합니다(런타임 의존성 없음).
 * - 과목 허브 작성 자격은 `canWriteToCourseHub`(`hubWriteDecision`) 한 곳에서 판정합니다. active 사용자 + 그 과목 학교의 active 학교 메일 인증
 *   (C-01, ADR 0018). 허브 단계적 개방(PROOFU_EVOLUTION_PLAN §8.6 초안)도 여기에 더합니다.
 * - 교수 실명·평가 필드는 다루지 않습니다(§8.6).
 */
import type { CheckItem } from './publication-checks'

// ── 작성 자격 ────────────────────────────────────────────────────────────

export interface HubWriter {
  status: 'active' | 'suspended' | 'deleted'
  /**
   * 이 사용자의 active 학교 메일 인증이 가리키는 **정본** 학교 id들(C-01, ADR 0018). 호출자가 병합을 따라가 정본으로 넘깁니다.
   * 없으면 인증 없음으로 봅니다.
   */
  activeSchoolIds?: readonly string[]
}

export interface HubCourse {
  id: string
  /** 병합된 과목이면 정본 id. 호출자는 정본을 넘깁니다. */
  mergedInto: string | null
  /** 과목의 정본 학교 id. 인증을 요구하면 필요합니다(없으면 쓸 수 없음). */
  schoolId?: string | null
}

export interface HubWritePolicy {
  /**
   * 그 과목 학교의 active 학교 메일 인증을 요구할지(PROOFU_EVOLUTION_PLAN §8.6 "과목 허브 작성은 학교 인증 계정만").
   * 기본 true. false는 로컬·개발용이며 production 서버는 false로 시작하지 않습니다(PEERCHIVE_HUB_REQUIRE_AFFILIATION, ADR 0018).
   */
  requireAffiliation: boolean
}

export const DEFAULT_HUB_WRITE_POLICY: HubWritePolicy = { requireAffiliation: true }

export type HubWriteDecision =
  | { ok: true }
  | { ok: false; reason: 'inactive_user' | 'not_canonical' | 'affiliation_required' }

/**
 * 과목 허브(선배 노트 등)에 쓸 수 있는지와 그 이유. active 사용자 + 정본 과목 + (정책상 요구하면) 그 과목 학교의 active 학교 메일 인증.
 * 허브 개방 기준(공개 사례·노트 수) 같은 조건도 이 함수에만 더합니다. 읽기·포크·유용성 신호는 작성이 아니므로 이 판정을 쓰지 않습니다.
 */
export function hubWriteDecision(
  user: HubWriter | null | undefined,
  course: HubCourse | null | undefined,
  policy: HubWritePolicy = DEFAULT_HUB_WRITE_POLICY,
): HubWriteDecision {
  if (!user || user.status !== 'active') return { ok: false, reason: 'inactive_user' }
  if (!course || course.mergedInto !== null) return { ok: false, reason: 'not_canonical' }
  if (policy.requireAffiliation) {
    const schoolId = course.schoolId
    if (!schoolId || !(user.activeSchoolIds ?? []).includes(schoolId)) return { ok: false, reason: 'affiliation_required' }
  }
  return { ok: true }
}

/** `hubWriteDecision(...).ok`. */
export function canWriteToCourseHub(
  user: HubWriter | null | undefined,
  course: HubCourse | null | undefined,
  policy: HubWritePolicy = DEFAULT_HUB_WRITE_POLICY,
): boolean {
  return hubWriteDecision(user, course, policy).ok
}

// ── 선배 노트 ────────────────────────────────────────────────────────────

/** 질문 4개(supply-kit §2): 첫 주에 했어야 했던 일 / 가장 시간을 잡아먹은 곳 / 다시 한다면 다르게 할 것 / 미리 알았으면 좋았을 개념·자료. */
export const SENIOR_NOTE_QUESTIONS = ['firstWeek', 'timeSink', 'differently', 'wishKnew'] as const
export type SeniorNoteQuestion = (typeof SENIOR_NOTE_QUESTIONS)[number]
export type SeniorNoteAnswers = Partial<Record<SeniorNoteQuestion, string>>

export const SENIOR_NOTE_QUESTION_LABELS: Readonly<Record<SeniorNoteQuestion, string>> = {
  firstWeek: '첫 주에 했어야 했던 일',
  timeSink: '가장 시간을 많이 잡아먹은 곳',
  differently: '다시 한다면 다르게 할 것',
  wishKnew: '미리 알았으면 좋았을 개념·자료',
}

export const SENIOR_NOTE_ANSWER_MAX = 1000
export const SENIOR_NOTE_MIN_ANSWERS = 2
export const SENIOR_NOTE_DISPLAY_NAME_MAX = 40
export const SENIOR_NOTE_TERM_LABEL_MAX = 30
/** 사용자·과목마다 노트 수 한도(초안 남발 방지). */
export const SENIOR_NOTE_PER_COURSE_LIMIT = 3

/** 표시 방식: 계정 이름(name) / 직접 입력한 표시명(display) / 익명(anonymous, "익명 선배"). */
export const SENIOR_NOTE_DISPLAY_MODES = ['name', 'display', 'anonymous'] as const
export type SeniorNoteDisplayMode = (typeof SENIOR_NOTE_DISPLAY_MODES)[number]
export const ANONYMOUS_SENIOR_LABEL = '익명 선배'

/** 대략 총 소요 시간(supply-kit §2의 7번): ~10시간 / ~20시간 / ~40시간 / 40시간 이상. */
export const SENIOR_NOTE_TIME_BUCKETS = ['lt10h', 'lt20h', 'lt40h', 'forty_plus'] as const
export type SeniorNoteTimeBucket = (typeof SENIOR_NOTE_TIME_BUCKETS)[number]
export const SENIOR_NOTE_TIME_BUCKET_LABELS: Readonly<Record<SeniorNoteTimeBucket, string>> = {
  lt10h: '약 10시간 이하',
  lt20h: '약 20시간 이하',
  lt40h: '약 40시간 이하',
  forty_plus: '40시간 이상',
}

export const SENIOR_NOTE_STATUSES = ['draft', 'published', 'withdrawn', 'hidden'] as const
export type SeniorNoteStatus = (typeof SENIOR_NOTE_STATUSES)[number]

export type SeniorNoteAnswersCheck =
  | { ok: true; answers: SeniorNoteAnswers }
  | { ok: false; fields: Record<string, 'invalid' | 'too_long' | 'too_few' | 'unknown_key'> }

/**
 * 답 정규화·검증: 알려진 질문만(모르는 키 거부), 앞뒤 공백 제거, 빈 답은 뺌, 각 1000자 이하, 비어 있지 않은 답 2개 이상.
 * 줄바꿈은 그대로 둡니다.
 */
export function normalizeSeniorNoteAnswers(raw: unknown): SeniorNoteAnswersCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, fields: { answers: 'invalid' } }
  const fields: Record<string, 'invalid' | 'too_long' | 'too_few' | 'unknown_key'> = {}
  const answers: SeniorNoteAnswers = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SENIOR_NOTE_QUESTIONS as readonly string[]).includes(key)) {
      fields[`answers.${key}`] = 'unknown_key'
      continue
    }
    if (value === null || value === undefined) continue
    if (typeof value !== 'string') {
      fields[`answers.${key}`] = 'invalid'
      continue
    }
    const text = value.replace(/\r\n?/g, '\n').trim()
    if (!text) continue
    if ([...text].length > SENIOR_NOTE_ANSWER_MAX) {
      fields[`answers.${key}`] = 'too_long'
      continue
    }
    answers[key as SeniorNoteQuestion] = text
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields }
  if (Object.keys(answers).length < SENIOR_NOTE_MIN_ANSWERS) return { ok: false, fields: { answers: 'too_few' } }
  // 질문 순서대로 정렬해 저장(결정적).
  const ordered: SeniorNoteAnswers = {}
  for (const q of SENIOR_NOTE_QUESTIONS) if (answers[q]) ordered[q] = answers[q]
  return { ok: true, answers: ordered }
}

/** 공개 표시 이름. 익명은 항상 "익명 선배"(작성자 정보 없음). */
export function seniorNoteAuthorLabel(mode: SeniorNoteDisplayMode, displayNameSnapshot: string | null): string {
  if (mode === 'anonymous') return ANONYMOUS_SENIOR_LABEL
  const name = displayNameSnapshot?.trim()
  return name ? name : ANONYMOUS_SENIOR_LABEL
}

/** 공개 전 점검(publication-checks)에 넣을 항목: 답 4개, 표시 이름, 학기 표시. */
export function seniorNoteCheckItems(note: {
  answers: SeniorNoteAnswers
  displayName: string | null
  termLabel: string | null
}): CheckItem[] {
  const items: CheckItem[] = []
  for (const q of SENIOR_NOTE_QUESTIONS) {
    const value = note.answers[q]
    if (value) items.push({ kind: 'text', location: { kind: 'senior_note', field: `answers.${q}` }, value })
  }
  if (note.displayName) items.push({ kind: 'text', location: { kind: 'senior_note', field: 'displayName' }, value: note.displayName })
  if (note.termLabel) items.push({ kind: 'text', location: { kind: 'senior_note', field: 'termLabel' }, value: note.termLabel })
  return items
}

// ── 공개 스냅샷에서 읽기(구조적 타입) ─────────────────────────────────────

export interface HubSnapshotLog {
  key: string
  tag: string
  body: string
  payload: Record<string, unknown>
  links: ReadonlyArray<{ url: string; title: string | null }>
  recordedAt: string
  resolves: string | null
}

export interface HubSnapshotMilestone {
  key: string
  position: number
  title: string
  dueAt: string | null
}

export interface HubSnapshot {
  title: string
  summary: string
  kind: 'individual' | 'team'
  retrospective: boolean
  members: ReadonlyArray<unknown>
  milestones: ReadonlyArray<HubSnapshotMilestone>
  logs: ReadonlyArray<HubSnapshotLog>
}

export interface StuckItem {
  /** 스냅샷의 로그 키(공개마다 안정된 가명 키). 공개 페이지 앵커 `#public-<key>`. */
  key: string
  symptom: string
  keywords: string[]
  timeBucket: string | null
  /** 같은 스냅샷의 💡해결 로그가 이 막힘을 가리키는지. 해결 내용은 싣지 않습니다. */
  resolved: boolean
  recordedAt: string
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 공개 스냅샷의 🧱막힘 로그 → 막힘 카드. 증상·키워드·시간 구간·해결 여부만 옮깁니다(시도·오류 원문·해결 방법은 카드에 넣지 않음:
 * 자세한 내용은 공개 사례 페이지에서 봅니다).
 */
export function extractStuckItems(snapshot: HubSnapshot): StuckItem[] {
  const resolved = new Set(snapshot.logs.filter((l) => l.tag === 'solution' && l.resolves).map((l) => l.resolves!))
  return snapshot.logs
    .filter((l) => l.tag === 'stuck')
    .map((l) => ({
      key: l.key,
      symptom: asString(l.payload.symptom) || l.body,
      keywords: Array.isArray(l.payload.keywords) ? l.payload.keywords.filter((k): k is string => typeof k === 'string').slice(0, 10) : [],
      timeBucket: asString(l.payload.timeBucket) || null,
      resolved: resolved.has(l.key),
      recordedAt: l.recordedAt,
    }))
    .filter((item) => item.symptom.trim().length > 0)
}

/** 막힘 카드 정렬: 유용성 신호(나도 막힘 + 도움됨) 많은 순 → 최근 기록 순. 작성자별 합계는 쓰지 않습니다(§8.5). */
export function rankStuckItems<T extends { meToo: number; helped: number; recordedAt: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.meToo + b.helped - (a.meToo + a.helped) || (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0))
}

// ── 플랜 포크(§8.4 "계획은 포크, 답은 금지") ─────────────────────────────

export const FORK_REFERENCE_LIMIT = 10
export const FORK_MILESTONE_NOTE_MAX = 500

export interface ForkPlan {
  /** 마일스톤 이름(순서대로). 예정일은 복사하지 않고, 원래 계획의 상대 일수만 메모로 남깁니다. */
  milestones: Array<{ title: string; note: string | null }>
  /** 포함된 로그의 근거 링크(💡해결 로그 제외, 중복 제거, 최대 10개). */
  references: Array<{ url: string; title: string | null }>
}

const dayNumber = (day: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000)
}

/**
 * 공개 스냅샷 → 포크할 계획. **허용 목록**: 마일스톤 이름·순서, (있으면) 첫 예정일 기준 상대 일수, 로그의 참고 링크.
 * 그 밖의 것(로그 본문·막힘 해결·결정 내용·역할 선언·파일·사람 이름·날짜 자체·사용 조건)은 복사하지 않습니다.
 */
export function forkPlanFromSnapshot(snapshot: HubSnapshot): ForkPlan {
  const ordered = [...snapshot.milestones].sort((a, b) => a.position - b.position)
  const anchorDay = ordered.map((m) => (m.dueAt ? dayNumber(m.dueAt) : null)).find((d) => d !== null) ?? null
  const withDates = ordered.filter((m) => m.dueAt && dayNumber(m.dueAt) !== null).length
  const milestones = ordered.map((m) => {
    const day = m.dueAt ? dayNumber(m.dueAt) : null
    // 날짜가 둘 이상일 때만 상대 일수가 의미 있습니다.
    const note =
      anchorDay !== null && day !== null && withDates >= 2
        ? day === anchorDay
          ? '원래 계획의 첫 예정일(기준)'
          : `원래 계획에서 첫 예정일 기준 ${day - anchorDay >= 0 ? '+' : ''}${day - anchorDay}일`
        : null
    return { title: m.title.trim().slice(0, 80), note }
  }).filter((m) => m.title.length > 0)

  const seen = new Set<string>()
  const references: ForkPlan['references'] = []
  for (const log of snapshot.logs) {
    if (log.tag === 'solution') continue
    for (const link of log.links) {
      if (references.length >= FORK_REFERENCE_LIMIT) break
      if (!/^https?:\/\//i.test(link.url) || seen.has(link.url)) continue
      seen.add(link.url)
      references.push({ url: link.url, title: link.title?.trim() ? link.title.trim().slice(0, 200) : null })
    }
  }
  return { milestones, references }
}

/** 새 프로젝트 개요 메모(summary_by_student, 2000자)에 넣을 참고 자료 목록. 없으면 null. */
export function formatForkReferences(references: ForkPlan['references'], max = 2000): string | null {
  if (references.length === 0) return null
  const lines = ['참고 자료(포크한 계획에서 가져옴):']
  for (const ref of references) {
    const line = `- ${ref.title ? `${ref.title} ` : ''}${ref.url}`
    if ([...lines, line].join('\n').length > max) break
    lines.push(line)
  }
  return lines.length > 1 ? lines.join('\n') : null
}

/** 포크한 프로젝트 이름: "<원래 제목> 계획 포크"(120자 안). */
export function forkProjectTitle(originalTitle: string, max = 120): string {
  const suffix = ' 계획 포크'
  const base = originalTitle.trim() || '공개 사례'
  const room = max - suffix.length
  const chars = [...base]
  return `${chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : base}${suffix}`
}

// ── 유용성 신호 ──────────────────────────────────────────────────────────

export const SIGNAL_TARGET_KINDS = ['stuck_item', 'senior_note'] as const
export type SignalTargetKind = (typeof SIGNAL_TARGET_KINDS)[number]
export const SIGNAL_KINDS = ['me_too', 'helped'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

/** 막힘 카드는 "나도 여기서 막혔어요"·"도움됐어요", 선배 노트는 "도움됐어요"만. */
export function isAllowedSignal(target: SignalTargetKind, kind: SignalKind): boolean {
  return target === 'stuck_item' ? true : kind === 'helped'
}

// ── 검색 색인(파생 데이터) ────────────────────────────────────────────────

export const SEARCH_KINDS = ['case', 'stuck', 'note'] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]
export const SEARCH_QUERY_MAX = 100
export const SEARCH_SNIPPET_MAX = 200

/** 검색용 정규화: NFKC, 소문자, 공백 하나로. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim()
}

const snippet = (value: string, max = SEARCH_SNIPPET_MAX) => {
  const text = value.replace(/\s+/g, ' ').trim()
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text
}

export interface SearchDocDraft {
  kind: 'case' | 'stuck'
  /** stuck만: 로그 키. */
  itemKey: string | null
  title: string
  snippet: string
  searchText: string
}

/**
 * 공개 release 스냅샷 → 검색 문서(사례 1개 + 막힘 카드마다 1개). 막힘은 카드와 같은 필드(증상·키워드)만 색인합니다.
 * 과목 이름 등은 색인하지 않고, 검색 때 공개 행과 조인해 정본 과목으로 거릅니다.
 */
export function searchDocsFromSnapshot(snapshot: HubSnapshot): SearchDocDraft[] {
  const docs: SearchDocDraft[] = [
    {
      kind: 'case',
      itemKey: null,
      title: snapshot.title,
      snippet: snippet(snapshot.summary),
      searchText: normalizeSearchText(`${snapshot.title}\n${snapshot.summary}\n${snapshot.milestones.map((m) => m.title).join(' ')}`),
    },
  ]
  for (const item of extractStuckItems(snapshot)) {
    docs.push({
      kind: 'stuck',
      itemKey: item.key,
      title: snippet(item.symptom, 120),
      snippet: item.keywords.join(', '),
      searchText: normalizeSearchText(`${item.symptom}\n${item.keywords.join(' ')}`),
    })
  }
  return docs
}

/** 게시된 선배 노트 → 검색 문서 1개. */
export function searchDocFromSeniorNote(note: { answers: SeniorNoteAnswers; termLabel: string | null }): {
  title: string
  snippet: string
  searchText: string
} {
  const first = SENIOR_NOTE_QUESTIONS.map((q) => note.answers[q]).find(Boolean) ?? ''
  const all = SENIOR_NOTE_QUESTIONS.map((q) => note.answers[q] ?? '').join('\n')
  return {
    title: note.termLabel ? `선배 노트 · ${note.termLabel}` : '선배 노트',
    snippet: snippet(first),
    searchText: normalizeSearchText(`${note.termLabel ?? ''}\n${all}`),
  }
}
