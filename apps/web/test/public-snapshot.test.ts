/**
 * 공개 스냅샷 허용 목록·누출 테스트(DB 없이 실행, T-11).
 * 모든 비공개 열에 표식 문자열(SENTINEL)을 넣은 행으로 스냅샷을 만들고, 직렬화한 스냅샷·manifest·미리보기 응답 어디에도
 * 표식이 나오지 않는지 확인합니다. buildPublicSnapshot은 공개 데이터를 만드는 유일한 함수입니다(ADR 0011).
 */
import { describe, expect, it } from 'vitest'
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
  weeklyCheckins,
} from '@peerchive/db'
import { buildManifest, canonicalHash, memberKeyFor, publicKeyFor } from '../server/modules/publication/manifest'
import {
  type SnapshotSource,
  analyzeSelection,
  buildPublicSnapshot,
  sanitizeFileName,
  subjectProjection,
} from '../server/modules/publication/snapshot'
import type { CandidatePreviewDto, PublicSnapshot } from '../shared/types/api'

const S = (label: string) => `SENTINEL_${label}_7f3a`
const T = new Date('2026-12-20T00:00:00Z')
const PUB = '00000000-0000-4000-8000-0000000000aa'
const PROJECT = '00000000-0000-4000-8000-000000000001'
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000002'
const A = '00000000-0000-4000-8000-00000000000a' // 이름 공개
const B = '00000000-0000-4000-8000-00000000000b' // 익명
const C = '00000000-0000-4000-8000-00000000000c' // 미동의(제외)
const D = '00000000-0000-4000-8000-00000000000d' // 확인만 한 사람(공개 안 됨)

const user = (id: string, name: string): typeof users.$inferSelect => ({
  id,
  displayName: name,
  privateEmail: `${S('EMAIL')}-${id}@univ.ac.kr`,
  status: 'active',
  deletionRequestedAt: null,
  purgedAt: null,
  analyticsOptOut: false,
  // 선택 실명(C-03)은 공개 스냅샷 어디에도 들어가지 않습니다(SENTINEL 검사가 확인).
  realName: S('REALNAME'),
  createdAt: T,
  updatedAt: T,
})

const project: typeof projects.$inferSelect = {
  id: PROJECT,
  ownerId: A,
  title: S('PRIVATE_PROJECT_TITLE'),
  summaryByStudent: S('PRIVATE_PROJECT_SUMMARY'),
  goal: S('GOAL'),
  constraints: S('CONSTRAINTS'),
  kind: 'team',
  lifecycle: 'completed',
  courseTermId: '00000000-0000-4000-8000-0000000000c7',
  assignmentBriefId: null,
  retroMode: true,
  studyNameMode: null,
  studySchoolId: null,
  embargoUntil: new Date('2026-12-31T14:59:59Z'),
  version: 3,
  createdAt: T,
  updatedAt: T,
}

const version = (id: string, uploaderId: string, fileName: string): typeof artifactVersions.$inferSelect => ({
  id,
  artifactId: `${id.slice(0, -2)}ff`,
  versionNo: 1,
  uploaderId,
  fileName,
  declaredType: S('DECLARED_TYPE'),
  mediaType: 'application/pdf',
  bytes: 1234,
  sha256: 'a'.repeat(64),
  objectKey: `clean/${S('OBJECT_KEY')}`,
  scanStatus: 'clean',
  scanReason: S('SCAN_REASON'),
  scanEngine: S('SCAN_ENGINE'),
  scanAttempts: 1,
  scannedAt: T,
  metadataStripped: false,
  strippedSha256: 'b'.repeat(64),
  strippedBytes: 1234,
  metadataFindings: { format: 'pdf', fields: [{ field: 'Author', sample: S('PDF_AUTHOR_SAMPLE') }] },
  createdAt: T,
})
const artifact = (v: typeof artifactVersions.$inferSelect): typeof artifacts.$inferSelect => ({
  id: v.artifactId,
  projectId: PROJECT,
  uploaderId: v.uploaderId,
  kind: 'file',
  title: S('ARTIFACT_TITLE'),
  usageTerms: S('ARTIFACT_USAGE_MEMO'),
  createdAt: T,
  updatedAt: T,
})

const V1 = '00000000-0000-4000-8000-0000000001a1' // A의 파일, 이름 그대로
const V2 = '00000000-0000-4000-8000-0000000002a1' // B의 파일, 이름에 B의 실명
const V3 = '00000000-0000-4000-8000-0000000003a1' // C의 파일(제외)
const V4 = '00000000-0000-4000-8000-0000000004a1' // 마일스톤 스냅샷(B)
const v1 = version(V1, A, '/Users/kim/private/최종보고서.pdf')
const v2 = version(V2, B, '박익명_발표자료.pdf')
const v3 = version(V3, C, 'c-notes.pdf')
const v4 = version(V4, B, `프로토타입 ${S('SNAPSHOT_FILE')}.png`.replace(S('SNAPSHOT_FILE'), 'v2'))

const entry = (id: string, authorId: string, tag: (typeof logEntries.$inferSelect)['tag'], createdAt: Date): typeof logEntries.$inferSelect => ({
  id,
  projectId: PROJECT,
  authorId,
  tag,
  currentRevisionId: `${id.slice(0, -2)}r1`,
  source: tag === 'meeting' ? 'discord' : 'retro',
  retrospective: tag !== 'meeting',
  clientId: '00000000-0000-4000-8000-0000000c1d00',
  createdAt,
})
const revision = (
  e: typeof logEntries.$inferSelect,
  body: string,
  payload: Record<string, unknown>,
  extra: Partial<typeof logRevisions.$inferSelect> = {},
): typeof logRevisions.$inferSelect => ({
  id: e.currentRevisionId!,
  logEntryId: e.id,
  revisionNo: 2,
  tag: e.tag,
  body,
  payload,
  resolvesEntryId: null,
  milestoneId: null,
  links: [],
  claimedDate: '2026-11-01',
  recordedAt: new Date('2026-11-02T00:00:00Z'),
  aiGenerated: false,
  approvedAt: null,
  ...extra,
})

const M1 = '00000000-0000-4000-8000-0000000000e1'
const milestone: typeof milestones.$inferSelect = {
  id: M1,
  projectId: PROJECT,
  position: 1,
  title: '중간발표',
  note: S('MILESTONE_NOTE'),
  dueAt: '2026-10-15',
  claimedAt: '2026-10-16',
  retrospective: true,
  createdBy: A,
  version: 4,
  createdAt: T,
  updatedAt: T,
}
const snapshotRow: typeof milestoneSnapshots.$inferSelect = {
  milestoneId: M1,
  artifactVersionId: V4,
  note: S('SNAPSHOT_NOTE'),
  position: 1,
  retrospective: true,
  createdBy: B,
  createdAt: T,
}

const L_STUCK = '00000000-0000-4000-8000-0000000010ee'
const L_SOLUTION = '00000000-0000-4000-8000-0000000011ee'
const L_MEETING = '00000000-0000-4000-8000-0000000012ee'
const L_C = '00000000-0000-4000-8000-0000000013ee'
const L_UNSELECTED = '00000000-0000-4000-8000-0000000014ee'
const stuck = entry(L_STUCK, B, 'stuck', new Date('2026-10-01T00:00:00Z'))
const solution = entry(L_SOLUTION, A, 'solution', new Date('2026-10-02T00:00:00Z'))
const meeting = entry(L_MEETING, A, 'meeting', new Date('2026-10-03T00:00:00Z'))
const cLog = entry(L_C, C, 'progress', new Date('2026-10-04T00:00:00Z'))

function source(overrides: Partial<SnapshotSource> = {}): SnapshotSource {
  const claim = (id: string, userId: string): typeof roleClaims.$inferSelect => ({
    id,
    projectId: PROJECT,
    userId,
    currentRevisionId: `${id.slice(0, -2)}r1`,
    createdAt: new Date(`2026-10-1${id.endsWith('1cc') ? 1 : 2}T00:00:00Z`),
  })
  const claimA = claim('00000000-0000-4000-8000-0000000001cc', A)
  const claimC = claim('00000000-0000-4000-8000-0000000002cc', C)
  const claimRev = (c: typeof roleClaims.$inferSelect, text: string): typeof claimRevisions.$inferSelect => ({
    id: c.currentRevisionId!,
    claimId: c.id,
    revisionNo: 3,
    text,
    recordedAt: T,
  })
  const endorsement = (revId: string, endorserId: string, status: 'confirmed' | 'disputed'): typeof endorsements.$inferSelect => ({
    id: `${revId.slice(0, -2)}en`,
    claimRevisionId: revId,
    endorserId,
    status,
    note: S('ENDORSEMENT_NOTE'),
    createdAt: T,
    updatedAt: T,
  })
  const evidence = (revId: string, position: number, row: Partial<typeof claimEvidence.$inferSelect>): typeof claimEvidence.$inferSelect => ({
    claimRevisionId: revId,
    position,
    logEntryId: null,
    logRevisionId: null,
    artifactVersionId: null,
    ...row,
  })
  const revA = claimRev(claimA, 'API 입력 검증과 오류 처리 담당')
  const revC = claimRev(claimC, 'C의 선언')
  const school: typeof schools.$inferSelect = {
    id: '00000000-0000-4000-8000-0000000005c0',
    name: '한빛대학교',
    nameKey: S('NAME_KEY'),
    verifiedLabel: null,
    mergedInto: null,
    mergedAt: null,
    createdBy: A,
    kind: 'university',
    createdAt: T,
  }
  const course: typeof courses.$inferSelect = {
    id: '00000000-0000-4000-8000-0000000005c1',
    schoolId: school.id,
    code: 'CSE3021',
    codeKey: S('CODE_KEY'),
    title: '운영체제',
    titleKey: S('TITLE_KEY'),
    teamFindingDisabled: false,
    mergedInto: null,
    mergedAt: null,
    createdBy: A,
    createdAt: T,
  }
  const term: typeof courseTerms.$inferSelect = {
    id: project.courseTermId!,
    courseId: course.id,
    year: 2026,
    semester: 'fall',
    endsAt: new Date('2026-12-31T14:59:59Z'),
    mergedInto: null,
    createdBy: A,
    createdAt: T,
  }
  return {
    level: 'full',
    title: '도서관 혼잡도 웹앱',
    summary: '실시간 센서 대신 수동 입력으로 범위를 조정했다.',
    slug: 'library-crowd',
    project,
    course: { school, course, term },
    users: new Map([
      [A, user(A, '김공개')],
      [B, user(B, '박익명')],
      [C, user(C, '최거절')],
      [D, user(D, S('ENDORSER_NAME'))],
    ]),
    logs: [
      {
        entry: stuck,
        revision: revision(stuck, '빌드가 실패했다', {
          symptom: 'CORS 오류',
          keywords: ['cors'],
          errorText: 'Access-Control-Allow-Origin',
          attempts: ['프록시'],
          timeBucket: 'lt2h',
          answerCheck: true,
          [S('UNKNOWN_PAYLOAD_KEY')]: S('UNKNOWN_PAYLOAD_VALUE'),
        }),
        evidenceVersionIds: [V2, V3],
      },
      {
        entry: solution,
        revision: revision(
          solution,
          '프록시 설정으로 해결',
          { method: 'vite proxy', notAnswerConfirmed: true },
          {
            resolvesEntryId: L_STUCK,
            milestoneId: M1,
            links: [
              { url: 'https://github.com/org/repo/pull/3', title: 'PR' },
              { url: 'http://localhost:3000/projects/' + PROJECT, title: S('PRIVATE_ROUTE_LINK') },
              { url: 'javascript:alert(1)', title: S('JS_LINK') },
            ],
          },
        ),
        evidenceVersionIds: [V1],
      },
      {
        entry: meeting,
        revision: revision(meeting, '주간 회의', { attendees: [A, B, C], decisions: ['범위 축소'], followUps: ['테스트'] }, {
          resolvesEntryId: L_UNSELECTED,
        }),
        evidenceVersionIds: [],
      },
      { entry: cLog, revision: revision(cLog, 'C가 쓴 로그', {}), evidenceVersionIds: [] },
    ],
    milestones: [{ milestone, snapshots: [{ snapshot: snapshotRow, version: v4, artifact: artifact(v4) }] }],
    claims: [
      {
        claim: claimA,
        revision: revA,
        endorsements: [endorsement(revA.id, D, 'confirmed'), endorsement(revA.id, B, 'confirmed')],
        evidence: [
          evidence(revA.id, 0, { logEntryId: L_SOLUTION, logRevisionId: solution.currentRevisionId }),
          evidence(revA.id, 1, { logEntryId: L_UNSELECTED, logRevisionId: `${L_UNSELECTED.slice(0, -2)}r1` }),
          evidence(revA.id, 2, { artifactVersionId: V1 }),
        ],
      },
      { claim: claimC, revision: revC, endorsements: [], evidence: [] },
    ],
    artifacts: [v1, v2, v3].map((v) => ({ version: v, artifact: artifact(v) })),
    usageTerms: { [V1]: { kind: 'license', spdx: 'CC-BY-4.0' } },
    exposure: { [A]: 'name', [B]: 'anonymous', [C]: 'name' },
    publicKey: (kind, id) => publicKeyFor(PUB, kind, id),
    excludedUserIds: [C],
    privateOrigins: ['http://localhost:3000'],
    ...overrides,
  }
}

/** 이 프로젝트 밖·비공개 테이블 행(스냅샷 입력에 들어가지 않음을 보이기 위한 표식). */
const checkin: typeof weeklyCheckins.$inferSelect = {
  id: '00000000-0000-4000-8000-0000000c4ec0',
  projectId: OTHER_PROJECT,
  userId: A,
  isoWeek: '2026-W45',
  timeBucket: 'lt5h',
  difficulty: 4,
  note: S('CHECKIN_NOTE'),
  promotedLogEntryId: null,
  shareForStats: false,
  skipReasons: [S('SKIP_REASON')],
  createdAt: T,
  updatedAt: T,
}

const key = (userId: string) => memberKeyFor(PUB, userId)
const lk = (id: string) => publicKeyFor(PUB, 'l', id)
const CLAIM_A = '00000000-0000-4000-8000-0000000001cc'

describe('buildPublicSnapshot (whitelist)', () => {
  const snapshot = buildPublicSnapshot(source())

  it('never contains private columns, ids, storage keys, notes, emails or excluded people', () => {
    const preview: CandidatePreviewDto = {
      candidateId: '00000000-0000-4000-8000-00000000ca01',
      status: 'awaiting_consent',
      manifestHash: 'b'.repeat(64),
      snapshot,
    }
    const analysis = analyzeSelection(source())
    const manifest = buildManifest({ projectId: PROJECT, publicationId: PUB, snapshot, analysis, excludedUserIds: [C] })
    for (const serialized of [JSON.stringify(snapshot), JSON.stringify(preview)]) {
      expect(serialized).not.toMatch(/SENTINEL_/)
      expect(serialized).not.toContain('@univ.ac.kr')
      for (const id of [A, B, C, D, PROJECT, OTHER_PROJECT, project.courseTermId!, L_UNSELECTED, stuck.currentRevisionId!])
        expect(serialized, id).not.toContain(id)
      expect(serialized).not.toContain('최거절')
      expect(serialized).not.toContain('박익명')
      expect(serialized).not.toContain('/Users/kim')
      expect(serialized).not.toContain('localhost')
      expect(serialized).not.toContain(checkin.note!)
    }
    // manifest는 비공개(후보에만 저장)지만 이메일·메모·저장소 키는 여기에도 없습니다.
    expect(JSON.stringify(manifest)).not.toMatch(/SENTINEL_/)
  })

  it('C-08: only study snapshots carry studyNameMode (team snapshots keep the old key set, so old manifest hashes do not change)', () => {
    expect(snapshot.kind).toBe('team')
    expect('studyNameMode' in snapshot).toBe(false)
    const study = buildPublicSnapshot(source({ project: { ...project, kind: 'study', studyNameMode: 'anonymous' } }))
    expect(study.kind).toBe('study')
    expect(study.studyNameMode).toBe('anonymous')
    const display = buildPublicSnapshot(source({ project: { ...project, kind: 'study', studyNameMode: 'display' } }))
    expect(display.studyNameMode).toBe('display')
    // 방식만 다르면 manifest 다이제스트도 달라집니다(동의는 방식까지 포함한 내용에 묶임).
    expect(JSON.stringify(study)).not.toBe(JSON.stringify(display))
  })

  it('maps members to stable pseudonymous keys; anonymous members get "팀원 A" and no log authorship', () => {
    expect(snapshot.members).toEqual(
      [
        { key: key(A), label: '김공개', anonymous: false },
        { key: key(B), label: '팀원 A', anonymous: true },
      ].sort((x, y) => (x.key < y.key ? -1 : 1)),
    )
    expect(key(A)).toMatch(/^m_[0-9a-f]{12}$/)
    expect(memberKeyFor(PUB, A)).toBe(key(A))
    expect(memberKeyFor('00000000-0000-4000-8000-0000000000bb', A)).not.toBe(key(A))
    const [l1, l2, l3] = snapshot.logs
    expect(l1).toMatchObject({ key: lk(L_STUCK), tag: 'stuck', author: null })
    expect(l1!.key).toMatch(/^l_[0-9a-f]{12}$/)
    expect(l2).toMatchObject({ key: lk(L_SOLUTION), tag: 'solution', author: key(A), resolves: lk(L_STUCK), milestone: publicKeyFor(PUB, 'ms', M1), evidence: [V1] })
    expect(l3).toMatchObject({ key: lk(L_MEETING), tag: 'meeting', author: key(A), resolves: null })
    expect(l3!.payload).toEqual({ attendees: [key(A), key(B)], decisions: ['범위 축소'], followUps: ['테스트'] })
    // 제외한 C의 로그·선언은 없습니다.
    expect(snapshot.logs).toHaveLength(3)
    expect(snapshot.claims.map((c) => c.member)).toEqual([key(A)])
  })

  it('keeps only whitelisted payload fields, public links, revision and time markers, retrospective and source', () => {
    const [l1, l2] = snapshot.logs
    expect(l1!.payload).toEqual({ symptom: 'CORS 오류', keywords: ['cors'], errorText: 'Access-Control-Allow-Origin', attempts: ['프록시'], timeBucket: 'lt2h' })
    expect(l2!.links).toEqual([{ url: 'https://github.com/org/repo/pull/3', title: 'PR' }])
    expect(l1).toMatchObject({ retrospective: true, source: 'retro', revisionNo: 2, claimedDate: '2026-11-01', recordedAt: '2026-11-02T00:00:00.000Z' })
    // C의 파일(V3)은 근거에서도 빠집니다.
    expect(l1!.evidence).toEqual([V2])
    expect(snapshot.logs[2]).toMatchObject({ source: 'discord', retrospective: false })
    expect(snapshot.retrospective).toBe(true)
  })

  it('keeps claim status and counts only, and evidence only to included items', () => {
    expect(snapshot.claims).toEqual([
      {
        key: publicKeyFor(PUB, 'c', CLAIM_A),
        member: key(A),
        text: 'API 입력 검증과 오류 처리 담당',
        revisionNo: 3,
        status: 'confirmed',
        confirmedCount: 2,
        disputedCount: 0,
        evidence: [
          { kind: 'log', log: lk(L_SOLUTION) },
          { kind: 'artifact', artifactVersionId: V1 },
        ],
      },
    ])
  })

  it('stores artifacts as version id + media type + size + sanitized name + usage; milestone snapshot files are included', () => {
    expect(snapshot.artifacts.map((a) => a.artifactVersionId)).toEqual([V1, V2, V4])
    const byId = new Map(snapshot.artifacts.map((a) => [a.artifactVersionId, a]))
    expect(byId.get(V1)).toEqual({ artifactVersionId: V1, displayName: '최종보고서.pdf', mediaType: 'application/pdf', bytes: 1234, usage: { kind: 'license', spdx: 'CC-BY-4.0' } })
    expect(byId.get(V2)!.displayName).toBe('파일 2.pdf')
    expect(byId.get(V2)!.usage).toEqual({ kind: 'view_only' })
    expect(snapshot.milestones).toEqual([
      {
        key: publicKeyFor(PUB, 'ms', M1),
        position: 1,
        title: '중간발표',
        dueAt: '2026-10-15',
        claimedAt: '2026-10-16',
        retrospective: true,
        snapshots: [{ artifactVersionId: V4, retrospective: true }],
      },
    ])
    expect(snapshot.course).toEqual({ school: '한빛대학교', course: '운영체제', code: 'CSE3021', year: 2026, semester: 'fall' })
  })

  it('summary level carries no artifacts, milestone snapshots or file evidence', () => {
    const summary = buildPublicSnapshot(source({ level: 'summary' }))
    expect(summary.artifacts).toEqual([])
    expect(summary.milestones[0]!.snapshots).toEqual([])
    expect(summary.logs.every((l) => l.evidence.length === 0)).toBe(true)
    expect(summary.claims[0]!.evidence).toEqual([{ kind: 'log', log: lk(L_SOLUTION) }])
    // 요약 공개에서는 파일을 올린 것만으로는 당사자가 되지 않습니다.
    const analysis = analyzeSelection(source({ level: 'summary', logs: [], claims: [] }))
    expect([...analysis.contributors.keys()]).toEqual([])
  })

  it('computes consent subjects from authorship, meetings, claims and uploads (excluded people removed)', () => {
    const analysis = analyzeSelection(source())
    expect(Object.fromEntries(analysis.contributors)).toEqual({
      [A]: ['artifacts', 'claims', 'logs', 'meetings', 'name'],
      [B]: ['anonymous_label', 'artifacts', 'logs', 'meetings'],
    })
    const withC = analyzeSelection(source({ excludedUserIds: [] }))
    expect(withC.contributors.get(C)).toEqual(['artifacts', 'claims', 'logs', 'meetings', 'name'])
    // 확인만 한 사람(D)은 공개되지 않으므로 당사자가 아닙니다.
    expect(withC.contributors.has(D)).toBe(false)
  })

  it('is deterministic: same input → same snapshot and manifest hash; any visible change → different hash', () => {
    const hashOf = (s: SnapshotSource) => {
      const snap = buildPublicSnapshot(s)
      return canonicalHash(buildManifest({ projectId: PROJECT, publicationId: PUB, snapshot: snap, analysis: analyzeSelection(s), excludedUserIds: s.excludedUserIds }))
    }
    expect(hashOf(source())).toBe(hashOf(source()))
    // 입력 순서가 달라도 같은 해시.
    const reversed = source()
    expect(hashOf({ ...reversed, logs: [...reversed.logs].reverse(), artifacts: [...reversed.artifacts].reverse() })).toBe(hashOf(source()))
    expect(hashOf(source({ title: '도서관 혼잡도 웹앱!' }))).not.toBe(hashOf(source()))
    expect(hashOf(source({ exposure: { [A]: 'anonymous', [B]: 'anonymous' } }))).not.toBe(hashOf(source()))
    expect(hashOf(source({ usageTerms: {} }))).not.toBe(hashOf(source()))
    // 고정 revision이 아닌 비공개 열(체크인 등)은 스냅샷 입력이 아니므로 해시와 무관합니다.
    expect(JSON.stringify(buildPublicSnapshot(source()))).toBe(JSON.stringify(snapshot))
  })

  it('subject projection covers only that person and the shared frame', () => {
    const analysis = analyzeSelection(source())
    const projB = subjectProjection(snapshot, analysis.refs, B) as { logs: PublicSnapshot['logs']; artifacts: PublicSnapshot['artifacts']; claims: unknown[] }
    expect(projB.logs.map((l) => l.key)).toEqual([lk(L_STUCK), lk(L_MEETING)])
    expect(projB.artifacts.map((a) => a.artifactVersionId)).toEqual([V2, V4])
    expect(projB.claims).toEqual([])
  })
})

describe('sanitizeFileName', () => {
  it('drops directories and control characters and replaces names that leak people or contacts', () => {
    expect(sanitizeFileName('C:\\Users\\kim\\보고서.pdf', 1, [])).toBe('보고서.pdf')
    expect(sanitizeFileName('김민수_발표.PPTX', 2, ['김민수'])).toBe('파일 2.pptx')
    expect(sanitizeFileName('연락처 010-1234-5678.png', 3, [])).toBe('파일 3.png')
    expect(sanitizeFileName('me@univ.ac.kr.pdf', 4, [])).toBe('파일 4.pdf')
    expect(sanitizeFileName('2019123456_과제.pdf', 5, [])).toBe('파일 5.pdf')
    expect(sanitizeFileName('a\u0000b.pdf', 6, [])).toBe('ab.pdf')
    expect(sanitizeFileName('', 7, [])).toBe('파일 7')
  })
})
