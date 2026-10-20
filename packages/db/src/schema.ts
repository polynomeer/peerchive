/**
 * 첫 vertical slice 스키마 (SYSTEM_DESIGN §6.1–§6.3 일부).
 *
 * 범위: 신원·프로필, 강의 아카이브 골격(학교·과목·학기), 과제 공간·멤버·초대, 빌드 로그(revision).
 * T-02/T-03(0001 migration): 로그인 계정(auth_accounts)·세션·매직링크·rate limit, 초대 취소,
 * 프로젝트 version(낙관적 동시성), 감사 이벤트(§6.6 AuditEvent 최소형).
 * T-04(0002 migration): 로그 태그 고정(log_entries.tag + 복합 외래 키), 재전송 중복 방지(client_id),
 * 근거 링크(log_revisions.links), 목록 조회 인덱스.
 * T-05(0003 migration): 산출물(artifacts)·버전(artifact_versions)·업로드 의도(upload_intents),
 * 로그 revision의 파일 근거(log_revision_evidence), 작업 outbox(outbox_events, ADR 0004·0007).
 * T-06(0004 migration): 마일스톤(milestones)·스냅샷(milestone_snapshots), 로그 revision의 마일스톤(log_revisions.milestone_id).
 * T-07(0005 migration): 할 일(tasks, 원본 Card 계승)과 빌드 로그 전환 연결(tasks.log_entry_id),
 * 사후 작성 표시(log_entries·milestones·milestone_snapshots.retrospective, 만들 때의 projects.retro_mode로 고정).
 * T-08(0006 migration): 역할 선언(role_claims)·revision(claim_revisions)·근거(claim_evidence)·팀원 확인(endorsements).
 * 공개(Publication)·동의는 다음 slice에서 추가합니다.
 *
 * 원칙
 * - 외래 키는 기본 `no action`입니다. 공동 기록·동의·철회의 파급을 먼저 계산해야 하므로
 *   무조건 cascade하지 않습니다(§6.6).
 * - 스키마 변경은 drizzle-kit이 생성한 SQL migration으로만 합니다(sync 금지).
 * - 이 테이블의 행을 공개 DTO로 그대로 내보내지 않습니다(§5).
 */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

// ── enums ────────────────────────────────────────────────────────────────

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'deleted'])
export const contactPolicy = pgEnum('contact_policy', ['closed', 'on_request', 'open'])
export const semester = pgEnum('semester', ['spring', 'summer', 'fall', 'winter'])
export const projectKind = pgEnum('project_kind', ['individual', 'team'])
export const projectLifecycle = pgEnum('project_lifecycle', ['planning', 'active', 'completed', 'archived'])
export const projectRole = pgEnum('project_role', ['owner', 'editor', 'reviewer', 'viewer'])
export const membershipStatus = pgEnum('membership_status', ['invited', 'active', 'left', 'removed'])
/** 로그인 수단. OAuth 공급자는 아직 구현하지 않았지만 같은 테이블에 추가합니다(ADR 0006). */
export const authProvider = pgEnum('auth_provider', ['email', 'google', 'github', 'kakao'])
export const logSource = pgEnum('log_source', ['web', 'discord', 'ai', 'task', 'retro'])
export const logTag = pgEnum('log_tag', [
  'progress',
  'stuck',
  'solution',
  'decision',
  'meeting',
  'validation',
  'retro',
])
/** 산출물 종류(§6.3). 지금은 file만 만들 수 있고 link/repo/demo는 다음 slice에서 씁니다. */
export const artifactKind = pgEnum('artifact_kind', ['file', 'link', 'repo', 'demo'])
/** 파일 검사 상태(§10). 전이 규칙은 @peerchive/domain의 nextScanStatus입니다. */
export const scanStatus = pgEnum('scan_status', ['pending', 'scanning', 'clean', 'quarantined', 'failed'])
/** 할 일 상태(원본 ProofU List의 Todo/Doing/Done). 전이 규칙은 @peerchive/domain의 statusChange입니다. */
export const taskStatus = pgEnum('task_status', ['todo', 'doing', 'done'])
/** 팀원 확인 상태(§7.3). 철회는 행을 지웁니다. 판정 규칙은 @peerchive/domain의 claimStatus입니다. */
export const endorsementStatus = pgEnum('endorsement_status', ['confirmed', 'disputed'])

// ── 신원·프로필 (§6.1) ───────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    /** 로그인·알림용. 공개 DTO에 싣지 않습니다. */
    privateEmail: text('private_email').notNull(),
    status: userStatus('status').notNull().default('active'),
    /** 탈퇴 요청 시각. 요청 즉시 status='deleted'로 바꾸고, 실제 삭제(purge)는 별도 작업입니다. */
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_private_email_lower_key').on(sql`lower(${t.privateEmail})`)],
)

/**
 * 로그인 수단과 사용자의 연결. email은 소문자로 정규화한 주소, OAuth는 공급자의 고유 ID를 씁니다.
 * 한 사용자가 여러 수단을 가질 수 있습니다.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: authProvider('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('auth_accounts_provider_account_key').on(t.provider, t.providerAccountId),
    index('auth_accounts_user_id_idx').on(t.userId),
  ],
)

/**
 * 로그인 세션. 쿠키 값은 `<id>.<secret>`이며 secret은 SHA-256 해시만 저장합니다.
 * 로그아웃·탈퇴·정지는 행을 지워 즉시 무효화합니다.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    secretHash: text('secret_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
)

/** 이메일 매직링크. 원문 토큰은 저장하지 않고, 한 번 쓰면 used_at을 채웁니다. */
export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 소문자로 정규화한 주소. */
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('magic_link_tokens_email_idx').on(t.email)],
)

/**
 * 고정 창(fixed window) rate limit 카운터. key에는 원문 이메일·IP 대신 해시를 넣습니다.
 * 오래된 행 정리는 작업 큐 도입 후 주기 작업으로 합니다(TODO, ADR 0004).
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'rate_limit_buckets_pkey', columns: [t.key, t.windowStart] })],
)

export const profiles = pgTable(
  'profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    handle: text('handle').notNull().unique(),
    headline: text('headline'),
    jobTargets: text('job_targets').array().notNull().default(sql`'{}'::text[]`),
    /** 선택 입력. 학교 인증 의미 없음. */
    schoolLabel: text('school_label'),
    gradTerm: text('grad_term'),
    contactPolicy: contactPolicy('contact_policy').notNull().default('closed'),
    openToWork: boolean('open_to_work').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // 세부 규칙(예약어, 앞뒤 하이픈)은 애플리케이션이 검증하고, DB는 문자 집합·길이만 막습니다.
  (t) => [check('profiles_handle_format_check', sql`${t.handle} ~ '^[a-z0-9-]{3,30}$'`)],
)

// ── 강의 아카이브 골격 (§6.2) ────────────────────────────────────────────

export const schools = pgTable('schools', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** 운영자 병합 표시. 공식 인증 의미 없음. */
  verifiedLabel: text('verified_label'),
  createdAt: createdAt(),
})

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    code: text('code'),
    title: text('title').notNull(),
    /** 정규화는 삭제가 아니라 병합으로 합니다. */
    mergedInto: uuid('merged_into').references((): AnyPgColumn => courses.id),
    createdAt: createdAt(),
  },
  (t) => [index('courses_school_id_idx').on(t.schoolId)],
)

export const courseTerms = pgTable(
  'course_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    year: integer('year').notNull(),
    semester: semester('semester').notNull(),
    /** 엠바고 기준 시각. */
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('course_terms_course_year_semester_key').on(t.courseId, t.year, t.semester),
    check('course_terms_year_check', sql`${t.year} between 1900 and 2200`),
  ],
)

// ── 과제 공간 (§6.3) ─────────────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 운영 책임자. 공동 권리 독점 아님. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    summaryByStudent: text('summary_by_student'),
    goal: text('goal'),
    constraints: text('constraints'),
    kind: projectKind('kind').notNull().default('individual'),
    lifecycle: projectLifecycle('lifecycle').notNull().default('planning'),
    courseTermId: uuid('course_term_id').references(() => courseTerms.id),
    /** assignment_briefs 테이블은 다음 slice에서 추가하며 그때 외래 키를 겁니다. */
    assignmentBriefId: uuid('assignment_brief_id'),
    /**
     * 사후 작성 모드(이미 끝난 과제를 거꾸로 정리). 이 모드에서 만든 로그·마일스톤·스냅샷은 각 행의 retrospective로
     * 표시가 고정되므로, 나중에 모드를 꺼도 기존 항목의 `사후 작성` 표시는 남습니다. 변경은 owner만(T-07).
     */
    retroMode: boolean('retro_mode').notNull().default(false),
    /** 낙관적 동시성용. 수정할 때마다 1씩 올리고, 요청의 expectedVersion과 다르면 409입니다. */
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('projects_owner_id_idx').on(t.ownerId),
    index('projects_course_term_id_idx').on(t.courseTermId),
    check('projects_version_check', sql`${t.version} >= 1`),
  ],
)

export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: projectRole('role').notNull(),
    partLabel: text('part_label'),
    status: membershipStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('project_members_project_id_user_id_key').on(t.projectId, t.userId),
    index('project_members_user_id_idx').on(t.userId),
  ],
)

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** 원문 토큰은 저장하지 않습니다. */
    tokenHash: text('token_hash').notNull().unique(),
    role: projectRole('role').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by').references(() => users.id),
    /** owner가 취소한 시각. 취소된 초대는 수락할 수 없습니다. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitations_project_id_idx').on(t.projectId),
    check('invitations_role_not_owner_check', sql`${t.role} <> 'owner'`),
  ],
)

export const logEntries = pgTable(
  'log_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /**
     * 로그 태그. 만든 뒤 바꾸지 않습니다. 목록 필터용으로 entry에 두고,
     * 모든 revision의 tag가 이 값과 같도록 log_revisions에서 (log_entry_id, tag) 복합 외래 키로 강제합니다.
     */
    tag: logTag('tag').notNull(),
    /** 첫 revision 저장 전에는 null. log_revisions와 순환 참조이므로 아래 foreignKey로 선언합니다. */
    currentRevisionId: uuid('current_revision_id'),
    source: logSource('source').notNull().default('web'),
    /**
     * 사후 작성 표시. 만들 때의 projects.retro_mode로 정하고 바꾸지 않습니다(T-07). source가 출처(web/task/retro)라면
     * 이 값은 신뢰 표시입니다: 사후 작성 과제에서 할 일을 전환한 로그는 source='task'이면서 retrospective=true입니다.
     */
    retrospective: boolean('retrospective').notNull().default(false),
    /**
     * 클라이언트가 만든 재전송 식별자(선택). 네트워크 오류 뒤 같은 요청을 다시 보내도
     * (project_id, author_id, client_id)가 같으면 새 로그를 만들지 않습니다. NULL끼리는 겹쳐도 됩니다.
     */
    clientId: uuid('client_id'),
    createdAt: createdAt(),
  },
  // log_revisions와 서로 참조하므로 반환 타입을 명시해 순환 추론을 끊습니다.
  (t): PgTableExtraConfigValue[] => [
    // 타임라인: 프로젝트별 최신순(created_at, id) cursor 페이지네이션.
    index('log_entries_project_created_idx').on(t.projectId, t.createdAt.desc(), t.id.desc()),
    // 태그 필터(🧱막힘·⚖️결정·✅검증 모아 보기).
    index('log_entries_project_tag_created_idx').on(t.projectId, t.tag, t.createdAt.desc(), t.id.desc()),
    uniqueIndex('log_entries_client_id_key').on(t.projectId, t.authorId, t.clientId),
    // log_revisions의 (log_entry_id, tag) 복합 외래 키 대상.
    unique('log_entries_id_tag_key').on(t.id, t.tag),
    foreignKey({
      name: 'log_entries_current_revision_id_fk',
      columns: [t.currentRevisionId],
      foreignColumns: [logRevisions.id],
    }),
  ],
)

export const logRevisions = pgTable(
  'log_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    logEntryId: uuid('log_entry_id')
      .notNull()
      .references((): AnyPgColumn => logEntries.id),
    revisionNo: integer('revision_no').notNull(),
    tag: logTag('tag').notNull(),
    body: text('body').notNull(),
    /** tag별 구조화 필드. 형식은 애플리케이션의 JSON Schema로 검증합니다. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** solution → 해결한 stuck 로그. */
    resolvesEntryId: uuid('resolves_entry_id').references((): AnyPgColumn => logEntries.id),
    /**
     * 이 revision이 속한 마일스톤(선택, 같은 프로젝트). 다른 내용처럼 revision마다 고정되며,
     * 이전 revision이 가리킨 마일스톤도 이력으로 남으므로 그 마일스톤은 지울 수 없습니다(T-06).
     */
    milestoneId: uuid('milestone_id').references((): AnyPgColumn => milestones.id),
    /**
     * 근거 링크 `[{url, title}]`(최대 10개, http/https만). 서버는 이 URL을 가져오지 않습니다.
     * 별도 테이블 대신 revision의 jsonb로 둡니다: revision은 추가만 하는 스냅샷이라 링크도 그 revision과
     * 함께 고정되고, 항상 revision과 같이 읽으며 링크 단위로 조회·참조하지 않습니다.
     * 출처 삭제 상태를 추적하는 참고 자료(§6.3 Reference)나 파일 근거(ArtifactVersion)는 별도 테이블로 둡니다.
     */
    links: jsonb('links').$type<Array<{ url: string; title: string | null }>>().notNull().default([]),
    /** 학생이 기입한 수행일(자기 주장). */
    claimedDate: date('claimed_date'),
    /** 플랫폼 기록 시각. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    /** AI 생성물은 학생 승인 전까지 초안입니다. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('log_revisions_log_entry_id_revision_no_key').on(t.logEntryId, t.revisionNo),
    check('log_revisions_revision_no_check', sql`${t.revisionNo} >= 1`),
    check('log_revisions_payload_object_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
    check('log_revisions_links_array_check', sql`jsonb_typeof(${t.links}) = 'array'`),
    index('log_revisions_resolves_entry_id_idx').on(t.resolvesEntryId),
    // 마일스톤별 로그 수·삭제 가능 여부 확인.
    index('log_revisions_milestone_id_idx').on(t.milestoneId),
    // 태그 고정: revision의 tag는 entry의 tag와 같아야 합니다.
    foreignKey({
      name: 'log_revisions_entry_tag_fk',
      columns: [t.logEntryId, t.tag],
      foreignColumns: [logEntries.id, logEntries.tag],
    }),
  ],
)

// ── 산출물·파일 (§6.3, §10, ADR 0007) ───────────────────────────────────

/**
 * 산출물. 내용은 버전(artifact_versions)에 쌓고, 내용이 바뀌면 새 버전을 만듭니다.
 * title은 처음 올린 파일 이름(표시용)이며 저장 경로에 쓰지 않습니다.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    kind: artifactKind('kind').notNull().default('file'),
    title: text('title').notNull(),
    /** 사용 조건(출처·라이선스 메모). 아직 입력 화면은 없습니다. */
    usageTerms: text('usage_terms'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('artifacts_project_created_idx').on(t.projectId, t.createdAt.desc(), t.id.desc())],
)

/**
 * 산출물 버전(파일 하나). object_key는 저장소 안의 위치이며 무작위 UUID로만 만들고(원 파일명 사용 안 함),
 * 응답 DTO에 싣지 않습니다. 검사 전에는 격리 키, clean이 되면 정상 키로 옮깁니다.
 * 같은 산출물에 같은 내용(sha256)을 다시 올리면 새 버전을 만들지 않습니다(unique).
 */
export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    versionNo: integer('version_no').notNull(),
    /** 이 버전을 올린 사람. 사용자별 저장 한도 계산에 씁니다. */
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    /** 올릴 때의 파일 이름(표시·내려받기 이름용). 경로를 만들 때 쓰지 않습니다. */
    fileName: text('file_name').notNull(),
    /** 업로드 때 사용자가 선언한 형식. */
    declaredType: text('declared_type').notNull(),
    /** 서버가 signature로 판별한 형식(내려줄 때 Content-Type). 판별 전이면 null. */
    mediaType: text('media_type'),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    objectKey: text('object_key').notNull().unique(),
    scanStatus: scanStatus('scan_status').notNull().default('pending'),
    /** 격리·실패 사유(짧은 코드, 예: type_mismatch, malware). 파일 내용은 넣지 않습니다. */
    scanReason: text('scan_reason'),
    /** 검사기 이름(예: clamav, signature-only). */
    scanEngine: text('scan_engine'),
    scanAttempts: integer('scan_attempts').notNull().default(0),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('artifact_versions_artifact_id_version_no_key').on(t.artifactId, t.versionNo),
    unique('artifact_versions_artifact_id_sha256_key').on(t.artifactId, t.sha256),
    index('artifact_versions_uploader_id_idx').on(t.uploaderId),
    check('artifact_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('artifact_versions_bytes_check', sql`${t.bytes} >= 0`),
    check('artifact_versions_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
)

/**
 * 업로드 의도(15분). 의도를 만든 사용자만 내용을 올리고(PUT) 완료할 수 있습니다.
 * 받은 내용은 quarantine_key에 격리해 두고, 완료하면 artifact_versions 행이 같은 키를 이어받습니다.
 * 완료 전 만료된 의도의 격리 파일 정리는 주기 작업으로 합니다(TODO, ADR 0007).
 */
export const uploadIntents = pgTable(
  'upload_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 기존 산출물의 새 버전이면 그 산출물. null이면 완료할 때 새 산출물을 만듭니다. */
    artifactId: uuid('artifact_id').references(() => artifacts.id),
    fileName: text('file_name').notNull(),
    declaredType: text('declared_type').notNull(),
    /** 선언한 크기. 실제로 받은 크기가 다르면 업로드를 거부합니다. */
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    /** 재전송 식별자(선택). 같은 (project, user, client_id)면 같은 의도를 돌려줍니다. */
    clientId: uuid('client_id'),
    quarantineKey: text('quarantine_key').notNull().unique(),
    sha256: text('sha256'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    artifactVersionId: uuid('artifact_version_id').references(() => artifactVersions.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('upload_intents_client_id_key').on(t.projectId, t.userId, t.clientId),
    index('upload_intents_user_id_idx').on(t.userId),
    check('upload_intents_byte_size_check', sql`${t.byteSize} > 0`),
  ],
)

/**
 * 로그 revision의 파일 근거(§6 LogRevision ↔ ArtifactVersion). revision처럼 추가만 합니다.
 * 같은 프로젝트의 버전인지는 애플리케이션이 확인합니다.
 */
export const logRevisionEvidence = pgTable(
  'log_revision_evidence',
  {
    logRevisionId: uuid('log_revision_id')
      .notNull()
      .references(() => logRevisions.id),
    artifactVersionId: uuid('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ name: 'log_revision_evidence_pkey', columns: [t.logRevisionId, t.artifactVersionId] }),
    index('log_revision_evidence_artifact_version_id_idx').on(t.artifactVersionId),
  ],
)

// ── 마일스톤·스냅샷 (§6.3, T-06) ─────────────────────────────────────────

/**
 * 마일스톤. 순서 안내이며 완료 게이트가 아닙니다(PROOFU_EVOLUTION_PLAN §6.3).
 * position은 프로젝트 안에서 1부터 빈틈없이 이어집니다(순서 변경·삭제 때 애플리케이션이 다시 매김).
 * 프로젝트당 최대 12개는 애플리케이션이 프로젝트 행을 잠근 채 확인합니다.
 */
export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    note: text('note'),
    /** 예정일(계획). */
    dueAt: date('due_at'),
    /** 학생이 기입한 도달일(자기 주장). 플랫폼이 확인한 값이 아닙니다. */
    claimedAt: date('claimed_at'),
    /** 사후 작성 표시. 만들 때의 projects.retro_mode로 정하고 바꾸지 않습니다(T-07). */
    retrospective: boolean('retrospective').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    /** 낙관적 동시성용. 수정할 때마다 1씩 올리고, 요청의 expectedVersion과 다르면 409입니다. 순서 변경은 올리지 않습니다. */
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 순서 변경은 한 트랜잭션에서 두 단계(임시로 밀어낸 뒤 다시 매김)로 해 이 제약과 충돌하지 않게 합니다.
    unique('milestones_project_id_position_key').on(t.projectId, t.position),
    check('milestones_position_check', sql`${t.position} >= 1`),
    check('milestones_title_check', sql`char_length(${t.title}) between 1 and 80`),
    check('milestones_note_check', sql`${t.note} is null or char_length(${t.note}) <= 500`),
    check('milestones_version_check', sql`${t.version} >= 1`),
  ],
)

/**
 * 마일스톤 스냅샷: 그 시점 산출물 버전(진화 보기 단위). 같은 프로젝트의 clean 버전인지는 애플리케이션이 확인합니다.
 * 같은 버전을 한 마일스톤에 두 번 지정할 수 없습니다(다른 마일스톤에는 지정 가능). 마일스톤당 최대 6개.
 */
export const milestoneSnapshots = pgTable(
  'milestone_snapshots',
  {
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id),
    artifactVersionId: uuid('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    note: text('note'),
    position: integer('position').notNull(),
    /** 사후 작성 표시. 지정할 때의 projects.retro_mode로 정하고 바꾸지 않습니다(T-07). */
    retrospective: boolean('retrospective').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'milestone_snapshots_pkey', columns: [t.milestoneId, t.artifactVersionId] }),
    index('milestone_snapshots_artifact_version_id_idx').on(t.artifactVersionId),
    check('milestone_snapshots_position_check', sql`${t.position} >= 1`),
    check('milestone_snapshots_note_check', sql`${t.note} is null or char_length(${t.note}) <= 300`),
  ],
)

// ── 할 일 (§2.2 Card → Task, §6.3, T-07) ─────────────────────────────────

/**
 * 할 일(원본 ProofU Card 계승). 완료를 학습 기록으로 보지 않으며, 완료할 때 묻는 질문에 답하면 빌드 로그로 전환합니다.
 * position은 (프로젝트, 상태) 목록마다 1부터 빈틈없이 이어집니다(상태 변경·순서 변경·삭제 때 애플리케이션이 다시 매김).
 * 한도(열린 할 일 200개, 전체 500개)는 애플리케이션이 프로젝트 행을 잠근 채 확인합니다.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    note: text('note'),
    /** 담당자(선택). 지정·변경할 때 active 멤버인지 애플리케이션이 확인합니다. 나중에 나가도 지정은 남습니다. */
    assigneeId: uuid('assignee_id').references(() => users.id),
    /** 마감일(계획). */
    dueAt: date('due_at'),
    status: taskStatus('status').notNull().default('todo'),
    position: integer('position').notNull(),
    /** 완료한 시각·사람. 완료를 되돌리면 비웁니다. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
    /**
     * 이 할 일에서 전환한 빌드 로그(한 번만). 로그 쪽이 아니라 할 일 쪽에 두어 로그 스키마를 늘리지 않고,
     * unique로 한 로그가 두 할 일에 연결되지 않게 합니다. 연결된 할 일은 지우지 않습니다.
     */
    logEntryId: uuid('log_entry_id').references(() => logEntries.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    /** 낙관적 동시성용. 내용·상태를 바꿀 때마다 1씩 올립니다. 같은 상태 안의 순서 변경은 올리지 않습니다. */
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 순서 변경은 한 트랜잭션에서 두 단계(임시로 밀어낸 뒤 다시 매김)로 해 이 제약과 충돌하지 않게 합니다.
    unique('tasks_project_status_position_key').on(t.projectId, t.status, t.position),
    unique('tasks_log_entry_id_key').on(t.logEntryId),
    index('tasks_assignee_id_idx').on(t.assigneeId),
    check('tasks_position_check', sql`${t.position} >= 1`),
    check('tasks_title_check', sql`char_length(${t.title}) between 1 and 120`),
    check('tasks_note_check', sql`${t.note} is null or char_length(${t.note}) <= 1000`),
    check('tasks_version_check', sql`${t.version} >= 1`),
    // 완료 상태와 완료 시각은 함께 다닙니다.
    check('tasks_completed_check', sql`(${t.status} = 'done') = (${t.completedAt} is not null)`),
  ],
)

// ── 기여 (§6.4, §7.3, T-08) ─────────────────────────────────────────────

/**
 * 역할 선언(개인 주장). 내용은 revision(claim_revisions)에 쌓고, 수정은 항상 새 revision입니다.
 * current_revision_id가 최신 revision을 가리킵니다. 비율 합산을 강제하지 않습니다.
 * 멤버당 최대 10개는 애플리케이션이 프로젝트 행을 잠근 채 확인합니다.
 */
export const roleClaims = pgTable(
  'role_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** 선언한 사람. 수정은 이 사람만 합니다(owner 우회 없음). */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 첫 revision 저장 전에는 null. claim_revisions와 순환 참조이므로 아래 foreignKey로 선언합니다. */
    currentRevisionId: uuid('current_revision_id'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    index('role_claims_project_user_idx').on(t.projectId, t.userId, t.createdAt),
    foreignKey({
      name: 'role_claims_current_revision_id_fk',
      columns: [t.currentRevisionId],
      foreignColumns: [claimRevisions.id],
    }),
  ],
)

/** 선언 revision. 추가만 하며, 팀원 확인은 revision에 붙습니다(새 revision에 승계되지 않음). */
export const claimRevisions = pgTable(
  'claim_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references((): AnyPgColumn => roleClaims.id),
    revisionNo: integer('revision_no').notNull(),
    text: text('text').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('claim_revisions_claim_id_revision_no_key').on(t.claimId, t.revisionNo),
    check('claim_revisions_revision_no_check', sql`${t.revisionNo} >= 1`),
    check('claim_revisions_text_check', sql`char_length(${t.text}) between 1 and 300`),
  ],
)

/**
 * 선언 revision의 근거: 특정 로그 revision(저장할 때 그 로그의 현재 revision으로 고정) 또는 산출물 버전 중 하나.
 * revision당 최대 20개, 같은 로그·버전은 한 번만. 같은 프로젝트인지는 애플리케이션이 확인합니다.
 */
export const claimEvidence = pgTable(
  'claim_evidence',
  {
    claimRevisionId: uuid('claim_revision_id')
      .notNull()
      .references(() => claimRevisions.id),
    position: integer('position').notNull(),
    logEntryId: uuid('log_entry_id').references(() => logEntries.id),
    /** 고정한 로그 revision. 그 로그(log_entry_id)의 revision인지는 애플리케이션이 확인합니다. */
    logRevisionId: uuid('log_revision_id').references(() => logRevisions.id),
    artifactVersionId: uuid('artifact_version_id').references(() => artifactVersions.id),
  },
  (t) => [
    primaryKey({ name: 'claim_evidence_pkey', columns: [t.claimRevisionId, t.position] }),
    unique('claim_evidence_log_entry_key').on(t.claimRevisionId, t.logEntryId),
    unique('claim_evidence_artifact_version_key').on(t.claimRevisionId, t.artifactVersionId),
    index('claim_evidence_log_entry_id_idx').on(t.logEntryId),
    index('claim_evidence_artifact_version_id_idx').on(t.artifactVersionId),
    check('claim_evidence_position_check', sql`${t.position} between 0 and 19`),
    // 로그 근거(entry + 그 entry의 revision)와 파일 근거 중 정확히 하나.
    check(
      'claim_evidence_kind_check',
      sql`(${t.logEntryId} is not null and ${t.logRevisionId} is not null and ${t.artifactVersionId} is null)
        or (${t.logEntryId} is null and ${t.logRevisionId} is null and ${t.artifactVersionId} is not null)`,
    ),
  ],
)

/**
 * 팀원 확인·이의. 한 사람은 한 revision에 하나만 남기고 바꿀 수 있습니다(철회는 행 삭제).
 * 자기 확인 금지·같은 프로젝트 멤버·현재 revision만은 애플리케이션이 확인하고, 판정도 자기 확인을 무시합니다.
 */
export const endorsements = pgTable(
  'endorsements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimRevisionId: uuid('claim_revision_id')
      .notNull()
      .references(() => claimRevisions.id),
    endorserId: uuid('endorser_id')
      .notNull()
      .references(() => users.id),
    status: endorsementStatus('status').notNull(),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('endorsements_claim_revision_endorser_key').on(t.claimRevisionId, t.endorserId),
    index('endorsements_endorser_id_idx').on(t.endorserId),
    check('endorsements_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 500`),
  ],
)

/**
 * 작업 outbox(ADR 0004). 상태 변경과 같은 트랜잭션에 행을 남기면 worker의 전달기가 pg-boss 작업으로 옮깁니다.
 * 행 id를 작업 id로 써서 여러 번 전달해도 작업은 하나만 생깁니다.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** pg-boss 큐 이름(예: artifact-scan). */
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_events_undispatched_idx').on(t.createdAt).where(sql`${t.dispatchedAt} is null`),
    check('outbox_events_payload_object_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
)

// ── 운영 (§6.6) ──────────────────────────────────────────────────────────

/**
 * 감사 이벤트(최소형). 본문·토큰·메일 주소는 넣지 않고, metadata에는 역할 같은 최소 정보만 둡니다.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    projectId: uuid('project_id').references(() => projects.id),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_project_id_idx').on(t.projectId),
    index('audit_events_actor_id_idx').on(t.actorId),
    check('audit_events_metadata_object_check', sql`jsonb_typeof(${t.metadata}) = 'object'`),
  ],
)
