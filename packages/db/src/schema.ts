/**
 * 첫 vertical slice 스키마 (SYSTEM_DESIGN §6.1–§6.3 일부).
 *
 * 범위: 신원·프로필, 강의 아카이브 골격(학교·과목·학기), 과제 공간·멤버·초대, 빌드 로그(revision).
 * T-02/T-03(0001 migration): 로그인 계정(auth_accounts)·세션·매직링크·rate limit, 초대 취소,
 * 프로젝트 version(낙관적 동시성), 감사 이벤트(§6.6 AuditEvent 최소형).
 * T-04(0002 migration): 로그 태그 고정(log_entries.tag + 복합 외래 키), 재전송 중복 방지(client_id),
 * 근거 링크(log_revisions.links), 목록 조회 인덱스.
 * 공개(Publication)·동의·기여·파일은 다음 slice에서 추가합니다.
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
    // 태그 고정: revision의 tag는 entry의 tag와 같아야 합니다.
    foreignKey({
      name: 'log_revisions_entry_tag_fk',
      columns: [t.logEntryId, t.tag],
      foreignColumns: [logEntries.id, logEntries.tag],
    }),
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
