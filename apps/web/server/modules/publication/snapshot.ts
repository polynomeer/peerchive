/**
 * 공개 스냅샷 만들기 (T-11, SYSTEM_DESIGN §1 불변조건 1·2, §6.5, ADR 0011).
 *
 * `buildPublicSnapshot`이 공개 데이터를 만드는 **유일한** 함수입니다. 공개 페이지·포트폴리오(T-12/T-14)는 후보에 저장된
 * 이 결과를 그대로 내려주며, 비공개 테이블을 다시 읽어 공개 응답을 만들지 않습니다.
 *
 * 원칙
 * - 허용 목록: DB 행을 펼치지(...row) 않고 필드를 하나씩 고릅니다. 태그별 payload도 허용 키만 옮깁니다.
 * - 항상 빼는 것: 이메일, 사용자 id(공개마다 안정된 가명 키로 바꿈), 체크인, 비공개 메모(마일스톤·스냅샷 메모, 할 일),
 *   확인 메모·확인한 사람(상태와 개수만), 감사 정보, 이 사이트의 비공개 경로 링크, 저장소 키·검사 정보, 학기 id(학교·과목·학기
 *   이름만), 익명 팀원의 로그 작성자, 다른 프로젝트 자료, 원래 파일 이름(익명 팀원 이름·연락처가 들어 있으면 `파일 N`으로 바꿈).
 * - 포함한 것끼리만 가리킵니다: 로그의 마일스톤·해결 대상·파일 근거, 선언의 근거는 같은 스냅샷에 든 항목만 남습니다.
 * - 요약 공개(summary)는 산출물·스냅샷을 싣지 않습니다.
 * - 제외한 사람(미동의자)의 로그·선언·올린 파일·마일스톤 스냅샷과 회의 참석 표시는 빠집니다.
 * - 사후 작성 표시(retrospective)와 로그 출처(source)를 그대로 옮깁니다(T-07).
 *
 * `analyzeSelection`은 같은 포함 규칙으로 동의 당사자·범위·비공개 참조(refs)를 계산합니다(공개 데이터를 만들지 않음).
 */
import { claimStatusSummary, findEmails, findPhoneNumbers, findStudentIds, isRetrospectiveLog } from '@peerchive/domain'
import type {
  artifactVersions,
  artifacts,
  claimEvidence,
  claimRevisions,
  courseTerms,
  courses,
  endorsements,
  logEntries,
  logRevisions,
  milestoneSnapshots,
  milestones,
  projects,
  roleClaims,
  schools,
  users,
} from '@peerchive/db'
import type {
  ExposureMode,
  LogLinkDto,
  LogTag,
  PublicArtifact,
  PublicClaim,
  PublicLog,
  PublicMember,
  PublicMilestone,
  PublicSnapshot,
  PublicationLevel,
  UsageTerms,
} from '../../../shared/types/api'

type UserRow = typeof users.$inferSelect
type ProjectRow = typeof projects.$inferSelect
type LogEntryRow = typeof logEntries.$inferSelect
type LogRevisionRow = typeof logRevisions.$inferSelect
type MilestoneRow = typeof milestones.$inferSelect
type MilestoneSnapshotRow = typeof milestoneSnapshots.$inferSelect
type ArtifactRow = typeof artifacts.$inferSelect
type ArtifactVersionRow = typeof artifactVersions.$inferSelect
type RoleClaimRow = typeof roleClaims.$inferSelect
type ClaimRevisionRow = typeof claimRevisions.$inferSelect
type EndorsementRow = typeof endorsements.$inferSelect
type ClaimEvidenceRow = typeof claimEvidence.$inferSelect

/** 선택된 비공개 행들(서버가 권한·같은 프로젝트·검사 상태를 확인한 뒤 넘김). */
export interface SnapshotSource {
  level: PublicationLevel
  title: string
  summary: string
  slug: string
  project: ProjectRow
  course: { school: typeof schools.$inferSelect; course: typeof courses.$inferSelect; term: typeof courseTerms.$inferSelect } | null
  /** 이 스냅샷이 언급할 수 있는 사용자(작성자·참석자·선언자·올린 사람). */
  users: ReadonlyMap<string, UserRow>
  logs: ReadonlyArray<{ entry: LogEntryRow; revision: LogRevisionRow; evidenceVersionIds: readonly string[] }>
  milestones: ReadonlyArray<{
    milestone: MilestoneRow
    snapshots: ReadonlyArray<{ snapshot: MilestoneSnapshotRow; version: ArtifactVersionRow; artifact: ArtifactRow }>
  }>
  claims: ReadonlyArray<{
    claim: RoleClaimRow
    revision: ClaimRevisionRow
    endorsements: readonly EndorsementRow[]
    evidence: readonly ClaimEvidenceRow[]
  }>
  artifacts: ReadonlyArray<{ version: ArtifactVersionRow; artifact: ArtifactRow }>
  /** 버전 id → 사용 조건(없으면 열람만). */
  usageTerms: Readonly<Record<string, UsageTerms>>
  /** 사용자 id → 노출 방식(없으면 익명). */
  exposure: Readonly<Record<string, ExposureMode>>
  /**
   * 공개마다 안정된 키(id를 드러내지 않음): 팀원 `m`, 로그 `l`, 선언 `c`, 마일스톤 `ms`.
   * 같은 공개의 후보끼리는 같은 항목이 같은 키라서, 다른 항목이 빠져도 남은 항목의 키·참조가 바뀌지 않습니다.
   */
  publicKey: (kind: PublicKeyKind, id: string) => string
  /** 제외한 사람(미동의자). */
  excludedUserIds: readonly string[]
  /** 이 사이트의 origin(비공개 경로 링크를 뺌). */
  privateOrigins: readonly string[]
}

export type PublicKeyKind = 'm' | 'l' | 'c' | 'ms'

// ── 포함 규칙 ─────────────────────────────────────────────────────────────

interface IncludedArtifact {
  version: ArtifactVersionRow
  artifact: ArtifactRow
}

interface Included {
  logs: SnapshotSource['logs'][number][]
  milestones: Array<{ milestone: MilestoneRow; snapshots: SnapshotSource['milestones'][number]['snapshots'][number][] }>
  claims: SnapshotSource['claims'][number][]
  /** 선택한 파일 + 포함한 마일스톤 스냅샷의 파일(전체 공개만). 버전 id 순. */
  artifacts: IncludedArtifact[]
  /** 내용이 포함된 사람 → 포함 범위. */
  contributors: Map<string, Set<SubjectScope>>
}

export type SubjectScope = 'name' | 'anonymous_label' | 'logs' | 'meetings' | 'claims' | 'artifacts' | 'title_summary'

const byCreated = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function attendeesOf(revision: LogRevisionRow): string[] {
  if (revision.tag !== 'meeting') return []
  const raw = revision.payload.attendees
  return Array.isArray(raw) ? [...new Set(raw.filter((a): a is string => typeof a === 'string'))] : []
}

function includedRows(source: SnapshotSource): Included {
  const excluded = new Set(source.excludedUserIds)
  const full = source.level === 'full'
  const logs = source.logs.filter((l) => !excluded.has(l.entry.authorId)).sort((a, b) => byCreated(a.entry, b.entry))
  const claims = source.claims.filter((c) => !excluded.has(c.claim.userId)).sort((a, b) => byCreated(a.claim, b.claim))
  const milestoneRows = [...source.milestones]
    .sort((a, b) => a.milestone.position - b.milestone.position)
    .map(({ milestone, snapshots }) => ({
      milestone,
      snapshots: full ? [...snapshots].filter((s) => !excluded.has(s.version.uploaderId)).sort((a, b) => a.snapshot.position - b.snapshot.position) : [],
    }))
  const artifactsById = new Map<string, IncludedArtifact>()
  if (full) {
    for (const a of source.artifacts) if (!excluded.has(a.version.uploaderId)) artifactsById.set(a.version.id, a)
    for (const m of milestoneRows) for (const s of m.snapshots) artifactsById.set(s.version.id, { version: s.version, artifact: s.artifact })
  }
  const artifactList = [...artifactsById.values()].sort((a, b) => (a.version.id < b.version.id ? -1 : 1))

  const contributors = new Map<string, Set<SubjectScope>>()
  const add = (userId: string, scope: SubjectScope) => {
    if (excluded.has(userId)) return
    const set = contributors.get(userId) ?? new Set<SubjectScope>()
    set.add(scope)
    contributors.set(userId, set)
  }
  for (const l of logs) {
    add(l.entry.authorId, 'logs')
    for (const a of attendeesOf(l.revision)) add(a, 'meetings')
  }
  for (const c of claims) add(c.claim.userId, 'claims')
  for (const a of artifactList) add(a.version.uploaderId, 'artifacts')
  for (const [userId, set] of contributors) set.add(source.exposure[userId] === 'name' ? 'name' : 'anonymous_label')
  return { logs, milestones: milestoneRows, claims, artifacts: artifactList, contributors }
}

// ── 이름·파일 이름 ───────────────────────────────────────────────────────

const ANON_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** 공개 팀원 목록(가명 키 순). 익명 팀원은 키 순서대로 "팀원 A, B, …". */
function publicMembers(source: SnapshotSource, contributors: Included['contributors']): PublicMember[] {
  const keyed = [...contributors.keys()].map((userId) => ({ userId, key: source.publicKey('m', userId) }))
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  let anonymousIndex = 0
  return keyed.map(({ userId, key }) => {
    if (source.exposure[userId] === 'name') {
      const name = source.users.get(userId)?.displayName.trim()
      return { key, label: name || '이름 미설정', anonymous: false }
    }
    const n = anonymousIndex++
    return { key, label: `팀원 ${n < ANON_LETTERS.length ? ANON_LETTERS[n] : n + 1}`, anonymous: true }
  })
}

/** 익명 팀원의 실제 표시 이름(2글자 이상). 파일 이름 정리와 점검에 씁니다. */
export function anonymousNamesOf(source: SnapshotSource): string[] {
  const { contributors } = includedRows(source)
  return [...contributors.keys()]
    .filter((userId) => source.exposure[userId] !== 'name')
    .map((userId) => source.users.get(userId)?.displayName.trim() ?? '')
    .filter((name) => [...name].length >= 2)
}

/**
 * 공개할 파일 이름. 경로 부분과 제어 문자를 지우고, 익명 팀원 이름·메일·전화·학번이 들어 있으면 `파일 N.확장자`로 바꿉니다.
 */
export function sanitizeFileName(raw: string, index: number, anonymousNames: readonly string[]): string {
  // eslint-disable-next-line no-control-regex
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 && /^[A-Za-z0-9]{1,8}$/.test(base.slice(dot + 1)) ? base.slice(dot) : ''
  const lower = base.toLocaleLowerCase('ko-KR')
  const leaks =
    !base ||
    anonymousNames.some((name) => lower.includes(name.toLocaleLowerCase('ko-KR'))) ||
    findEmails(base).length > 0 ||
    findPhoneNumbers(base).length > 0 ||
    findStudentIds(base).length > 0
  return leaks ? `파일 ${index}${ext.toLowerCase()}` : base.slice(0, 200)
}

// ── 로그 ─────────────────────────────────────────────────────────────────

/** 태그별 공개 payload 허용 키. 회의 참석자(attendees)는 가명 키로 따로 옮깁니다. */
const PAYLOAD_FIELDS: Record<LogTag, readonly string[]> = {
  progress: [],
  retro: [],
  stuck: ['symptom', 'keywords', 'errorText', 'attempts', 'timeBucket'],
  solution: ['method', 'timeBucket'],
  decision: ['options', 'criteria', 'choice', 'hindsight'],
  validation: ['target', 'conditions', 'result', 'openQuestions'],
  meeting: ['decisions', 'followUps'],
}

function pickPayload(tag: LogTag, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of PAYLOAD_FIELDS[tag]) {
    const value = payload[field]
    if (typeof value === 'string') out[field] = value
    else if (Array.isArray(value)) out[field] = value.filter((v): v is string => typeof v === 'string')
  }
  return out
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

function publicLinks(links: LogRevisionRow['links'], privateOrigins: readonly string[]): LogLinkDto[] {
  const blocked = new Set(privateOrigins.map(originOf).filter((o): o is string => !!o))
  return links
    .filter((link) => typeof link.url === 'string' && /^https?:\/\//i.test(link.url))
    .filter((link) => {
      const origin = originOf(link.url)
      return origin !== null && !blocked.has(origin)
    })
    .map((link) => ({ url: link.url, title: typeof link.title === 'string' ? link.title : null }))
}

// ── 스냅샷 ───────────────────────────────────────────────────────────────

/** 스냅샷 안의 키. 로그·선언·마일스톤·팀원은 공개마다 안정된 키, 파일은 버전 id입니다. */
export interface SnapshotKeys {
  logKeyById: Map<string, string>
  claimKeyById: Map<string, string>
  milestoneKeyById: Map<string, string>
}

function keysFor(source: SnapshotSource, included: Included): SnapshotKeys {
  return {
    logKeyById: new Map(included.logs.map((l) => [l.entry.id, source.publicKey('l', l.entry.id)])),
    claimKeyById: new Map(included.claims.map((c) => [c.claim.id, source.publicKey('c', c.claim.id)])),
    milestoneKeyById: new Map(included.milestones.map((m) => [m.milestone.id, source.publicKey('ms', m.milestone.id)])),
  }
}

/** 선택된 비공개 행 → 공개 스냅샷. 공개 데이터를 만드는 유일한 함수입니다. */
export function buildPublicSnapshot(source: SnapshotSource): PublicSnapshot {
  const included = includedRows(source)
  const keys = keysFor(source, included)
  const members = publicMembers(source, included.contributors)
  const memberKeys = new Set(members.map((m) => m.key))
  const anonymousUsers = new Set([...included.contributors.keys()].filter((id) => source.exposure[id] !== 'name'))
  const anonymousNames = anonymousNamesOf(source)
  const artifactIds = new Set(included.artifacts.map((a) => a.version.id))
  const excluded = new Set(source.excludedUserIds)

  const artifactsOut: PublicArtifact[] = included.artifacts.map(({ version }, index) => ({
    artifactVersionId: version.id,
    displayName: sanitizeFileName(version.fileName, index + 1, anonymousNames),
    mediaType: version.mediaType,
    // 공개로 내려주는 내용(메타데이터 제거본)의 크기. backfill 전 버전은 후보에 들어오지 못합니다.
    bytes: version.strippedBytes ?? version.bytes,
    usage: publicUsage(source.usageTerms[version.id]),
  }))

  const milestonesOut: PublicMilestone[] = included.milestones.map(({ milestone, snapshots }, index) => ({
    key: keys.milestoneKeyById.get(milestone.id)!,
    position: index + 1,
    title: milestone.title,
    dueAt: milestone.dueAt,
    claimedAt: milestone.claimedAt,
    retrospective: milestone.retrospective,
    snapshots: snapshots.map(({ snapshot, version }) => ({
      artifactVersionId: version.id,
      retrospective: snapshot.retrospective,
    })),
  }))

  const logsOut: PublicLog[] = included.logs.map(({ entry, revision, evidenceVersionIds }) => {
    const payload = pickPayload(entry.tag, revision.payload)
    if (entry.tag === 'meeting') {
      payload.attendees = attendeesOf(revision)
        .filter((id) => !excluded.has(id))
        .map((id) => source.publicKey('m', id))
        .filter((key) => memberKeys.has(key))
    }
    return {
      key: keys.logKeyById.get(entry.id)!,
      tag: entry.tag,
      source: entry.source,
      retrospective: isRetrospectiveLog(entry),
      author: anonymousUsers.has(entry.authorId) ? null : source.publicKey('m', entry.authorId),
      body: revision.body,
      payload,
      links: publicLinks(revision.links, source.privateOrigins),
      claimedDate: revision.claimedDate,
      recordedAt: revision.recordedAt.toISOString(),
      revisionNo: revision.revisionNo,
      milestone: revision.milestoneId ? (keys.milestoneKeyById.get(revision.milestoneId) ?? null) : null,
      resolves: revision.resolvesEntryId ? (keys.logKeyById.get(revision.resolvesEntryId) ?? null) : null,
      evidence: evidenceVersionIds.filter((id) => artifactIds.has(id)),
    }
  })

  const claimsOut: PublicClaim[] = included.claims.map(({ claim, revision, endorsements: rows, evidence }) => {
    const summary = claimStatusSummary(
      { id: claim.id, projectId: claim.projectId, userId: claim.userId, revisions: [{ id: revision.id, revisionNo: revision.revisionNo }] },
      rows
        .filter((e) => e.claimRevisionId === revision.id)
        .map((e) => ({ claimRevisionId: e.claimRevisionId, endorserId: e.endorserId, status: e.status })),
    )
    const evidenceOut: PublicClaim['evidence'] = []
    for (const row of [...evidence].sort((a, b) => a.position - b.position)) {
      if (row.artifactVersionId) {
        if (artifactIds.has(row.artifactVersionId)) evidenceOut.push({ kind: 'artifact', artifactVersionId: row.artifactVersionId })
      } else if (row.logEntryId) {
        const key = keys.logKeyById.get(row.logEntryId)
        if (key) evidenceOut.push({ kind: 'log', log: key })
      }
    }
    return {
      key: keys.claimKeyById.get(claim.id)!,
      member: source.publicKey('m', claim.userId),
      text: revision.text,
      revisionNo: revision.revisionNo,
      status: summary.status,
      confirmedCount: summary.confirmedCount,
      disputedCount: summary.disputedCount,
      evidence: evidenceOut,
    }
  })

  const course = source.course
  return {
    format: 'peerchive.public-snapshot',
    schemaVersion: 1,
    level: source.level,
    slug: source.slug,
    title: source.title,
    summary: source.summary,
    kind: source.project.kind,
    retrospective: source.project.retroMode,
    course: course
      ? {
          school: course.school.name,
          course: course.course.title,
          code: course.course.code,
          year: course.term.year,
          semester: course.term.semester,
        }
      : null,
    members,
    milestones: milestonesOut,
    logs: logsOut,
    claims: claimsOut,
    artifacts: artifactsOut,
  }
}

function publicUsage(terms: UsageTerms | undefined): UsageTerms {
  if (!terms) return { kind: 'view_only' }
  switch (terms.kind) {
    case 'license':
      return { kind: 'license', spdx: terms.spdx }
    case 'external':
      return { kind: 'external', source: terms.source }
    default:
      return { kind: 'view_only' }
  }
}

// ── 비공개 분석(동의 당사자·참조) ─────────────────────────────────────────

/** 스냅샷 키 → 비공개 id. 후보에 저장하며 공개하지 않습니다(고치기 링크·당사자별 다이제스트용). */
export interface SnapshotRefs {
  logs: Record<string, { id: string; revisionId: string; authorId: string }>
  claims: Record<string, { id: string; revisionId: string; userId: string }>
  milestones: Record<string, { id: string }>
  artifacts: Record<string, { artifactId: string; uploaderId: string }>
  /** 가명 키 → 사용자 id. */
  members: Record<string, string>
}

export interface SelectionAnalysis {
  /** 내용이 포함된 사람 → 범위(정렬됨). */
  contributors: Map<string, SubjectScope[]>
  refs: SnapshotRefs
  included: {
    logs: Array<{ id: string; revisionId: string; revisionNo: number }>
    milestones: Array<{ id: string; version: number; snapshotVersionIds: string[] }>
    claims: Array<{ id: string; revisionId: string; revisionNo: number }>
    artifactVersionIds: string[]
  }
}

export function analyzeSelection(source: SnapshotSource): SelectionAnalysis {
  const included = includedRows(source)
  const keys = keysFor(source, included)
  const refs: SnapshotRefs = { logs: {}, claims: {}, milestones: {}, artifacts: {}, members: {} }
  for (const l of included.logs)
    refs.logs[keys.logKeyById.get(l.entry.id)!] = { id: l.entry.id, revisionId: l.revision.id, authorId: l.entry.authorId }
  for (const c of included.claims)
    refs.claims[keys.claimKeyById.get(c.claim.id)!] = { id: c.claim.id, revisionId: c.revision.id, userId: c.claim.userId }
  for (const m of included.milestones) refs.milestones[keys.milestoneKeyById.get(m.milestone.id)!] = { id: m.milestone.id }
  for (const a of included.artifacts) refs.artifacts[a.version.id] = { artifactId: a.artifact.id, uploaderId: a.version.uploaderId }
  for (const userId of included.contributors.keys()) refs.members[source.publicKey('m', userId)] = userId
  return {
    contributors: new Map([...included.contributors].map(([id, set]) => [id, [...set].sort()])),
    refs,
    included: {
      logs: included.logs.map((l) => ({ id: l.entry.id, revisionId: l.revision.id, revisionNo: l.revision.revisionNo })),
      milestones: included.milestones.map((m) => ({
        id: m.milestone.id,
        version: m.milestone.version,
        snapshotVersionIds: m.snapshots.map((s) => s.version.id),
      })),
      claims: included.claims.map((c) => ({ id: c.claim.id, revisionId: c.revision.id, revisionNo: c.revision.revisionNo })),
      artifactVersionIds: included.artifacts.map((a) => a.version.id),
    },
  }
}

/**
 * 한 당사자와 관련된 스냅샷 부분(동의 이어받기 판정용). 공통 틀(수준·제목·요약·slug·과목·마일스톤) + 그 사람의 팀원 항목·
 * 쓴 로그·참석한 회의·선언·올린 파일. 이 부분이 이전 후보와 같을 때만 미동의자 제외 후보에서 동의를 이어받습니다.
 */
export function subjectProjection(snapshot: PublicSnapshot, refs: SnapshotRefs, userId: string): Record<string, unknown> {
  const key = Object.entries(refs.members).find(([, id]) => id === userId)?.[0] ?? null
  return {
    frame: {
      level: snapshot.level,
      slug: snapshot.slug,
      title: snapshot.title,
      summary: snapshot.summary,
      kind: snapshot.kind,
      course: snapshot.course,
      retrospective: snapshot.retrospective,
    },
    milestones: snapshot.milestones,
    member: key ? (snapshot.members.find((m) => m.key === key) ?? null) : null,
    logs: snapshot.logs.filter(
      (l) =>
        refs.logs[l.key]?.authorId === userId ||
        (key !== null && Array.isArray(l.payload.attendees) && (l.payload.attendees as string[]).includes(key)),
    ),
    claims: key ? snapshot.claims.filter((c) => c.member === key) : [],
    artifacts: snapshot.artifacts.filter((a) => refs.artifacts[a.artifactVersionId]?.uploaderId === userId),
  }
}
