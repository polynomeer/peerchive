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
 * T-09(0007 migration): 외부 계정 연결(integrations)·일회용 연결 코드(discord_codes)·채널 연결(discord_channel_bindings)·
 * 📌 승인 요청(discord_pin_requests)·봇 알림 outbox(discord_notices)·내부 API nonce(internal_request_nonces)·
 * 주간 체크인(weekly_checkins). 결정은 ADR 0009.
 * T-10(0008 migration): pg_trgm 확장, 학교·과목의 정규화 키·병합(merged_into)·작성자, 개념 태그(concept_tags)·과목 연결
 * (course_concept_tags), 운영자(operators), 프로젝트 엠바고(projects.embargo_until, 단조 증가)·명시적 엠바고(embargoes).
 * 결정은 ADR 0010.
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
/** 외부 계정 공급자(§6.1 Integration). 지금은 discord만 연결합니다. */
export const integrationProvider = pgEnum('integration_provider', ['discord', 'github'])
/** 디스코드 일회용 코드 종류: 계정 연결(link) 또는 채널 연결(bind). */
export const discordCodeKind = pgEnum('discord_code_kind', ['link', 'bind'])
/** 남의 메시지 📌 승인 요청 상태. 결정되거나 만료되면 저장했던 메시지 내용을 지웁니다. */
export const pinRequestStatus = pgEnum('pin_request_status', ['pending', 'approved', 'rejected', 'expired'])
/** 봇이 채널에 보낼 예약 알림 종류. */
export const discordNoticeKind = pgEnum('discord_notice_kind', ['checkin_reminder', 'weekly_summary'])
/** 주간 체크인 투입 시간(0 / ~2h / ~5h / ~10h / 10h+, PROOFU_EVOLUTION_PLAN §6.4). */
export const checkinTimeBucket = pgEnum('checkin_time_bucket', ['none', 'lt2h', 'lt5h', 'lt10h', 'ten_plus'])
/** 명시적 엠바고의 범위(SYSTEM_DESIGN §6.6 Embargo). */
export const embargoScope = pgEnum('embargo_scope', ['project', 'course_term'])

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

// ── 운영자 (T-10) ────────────────────────────────────────────────────────

/**
 * 운영자. 학교·과목·개념 태그 병합, 학기 종료 시각 조정, 엠바고 낮추기만 할 수 있습니다(ADR 0010).
 * 비공개 과제 공간을 읽을 권한은 없습니다(§8). 부여·회수는 CLI(`pnpm --filter @peerchive/db grant-operator`)로만 하며
 * API로는 바꿀 수 없습니다. 회수는 revoked_at을 채우고, 다시 부여하면 새 시각으로 덮어씁니다.
 */
export const operators = pgTable('operators', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  /** CLI로 부여하면 null(운영 콘솔 사용자). */
  grantedBy: uuid('granted_by').references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

// ── 강의 아카이브 골격 (§6.2) ────────────────────────────────────────────

/**
 * 학교(학생 입력, "학생 작성"). 같은 학교가 여러 이름으로 들어오면 운영자가 병합합니다(merged_into, 삭제 없음).
 * name_key는 @peerchive/domain의 labelKey(공백·대소문자·구두점 무시)이며 pg_trgm 유사도 검색에 씁니다.
 * 정본(merged_into가 null)끼리는 name_key가 겹치지 않습니다.
 * 학교 메일 인증·공식 페이지(PROOFU_EVOLUTION_PLAN §8.6, §8.9.3)는 다음 slice에서 이 행에 붙입니다.
 */
export const schools = pgTable(
  'schools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    /** 운영자 병합 표시. 공식 인증 의미 없음. */
    verifiedLabel: text('verified_label'),
    /** 병합된 정본 학교. 정본은 항상 merged_into가 null이고(평탄화), 사슬·순환이 없습니다. */
    mergedInto: uuid('merged_into').references((): AnyPgColumn => schools.id),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('schools_name_key_canonical_key').on(t.nameKey).where(sql`${t.mergedInto} is null`),
    index('schools_name_key_trgm_idx').using('gin', t.nameKey.op('gin_trgm_ops')),
    index('schools_merged_into_idx').on(t.mergedInto),
    check('schools_not_self_merged_check', sql`${t.mergedInto} is null or ${t.mergedInto} <> ${t.id}`),
  ],
)

/**
 * 과목(학생 입력). 교수 이름·평가 필드는 두지 않습니다(§8.6). title_key·code_key는 중복 판정용 정규화 키입니다.
 * 같은 학교의 정본끼리 title_key가 겹치지 않게 애플리케이션이 학교별 advisory lock 안에서 확인합니다
 * (학교 병합으로 같은 이름 과목이 한 학교에 모일 수 있어 DB unique로 두지 않음).
 */
export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    code: text('code'),
    codeKey: text('code_key'),
    title: text('title').notNull(),
    titleKey: text('title_key').notNull(),
    /** 정규화는 삭제가 아니라 병합으로 합니다. 정본은 merged_into가 null(평탄화). */
    mergedInto: uuid('merged_into').references((): AnyPgColumn => courses.id),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('courses_school_id_idx').on(t.schoolId),
    index('courses_school_code_key_idx').on(t.schoolId, t.codeKey),
    index('courses_title_key_trgm_idx').using('gin', t.titleKey.op('gin_trgm_ops')),
    index('courses_merged_into_idx').on(t.mergedInto),
    check('courses_not_self_merged_check', sql`${t.mergedInto} is null or ${t.mergedInto} <> ${t.id}`),
  ],
)

/**
 * 개설 학기. ends_at은 서버가 학기에서 계산하고(@peerchive/domain semesterEndsAt) 운영자만 고칩니다(감사 기록).
 * 과목 병합 때 대상 과목에 같은 (연도, 학기)가 있으면 이 행은 merged_into로 그쪽을 가리키고 프로젝트를 옮깁니다.
 */
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
    mergedInto: uuid('merged_into').references((): AnyPgColumn => courseTerms.id),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('course_terms_course_year_semester_key').on(t.courseId, t.year, t.semester),
    check('course_terms_year_check', sql`${t.year} between 1900 and 2200`),
    check('course_terms_not_self_merged_check', sql`${t.mergedInto} is null or ${t.mergedInto} <> ${t.id}`),
  ],
)

/**
 * 개념 태그(학생 작성, 학교 간 연결). slug는 @peerchive/domain normalizeTagSlug 결과이며 병합된 태그도 slug를 유지합니다
 * (같은 slug로 다시 추가하면 정본으로 이어짐).
 */
export const conceptTags = pgTable(
  'concept_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    label: text('label').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => conceptTags.id),
    mergedInto: uuid('merged_into').references((): AnyPgColumn => conceptTags.id),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('concept_tags_slug_trgm_idx').using('gin', t.slug.op('gin_trgm_ops')),
    index('concept_tags_merged_into_idx').on(t.mergedInto),
    check('concept_tags_slug_format_check', sql`char_length(${t.slug}) between 1 and 40`),
    check('concept_tags_not_self_merged_check', sql`${t.mergedInto} is null or ${t.mergedInto} <> ${t.id}`),
    check('concept_tags_not_self_parent_check', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
)

/** 과목 ↔ 개념 태그(과목당 12개, 정본 태그만). 연결 행은 병합 때 정본으로 옮기고 원본 연결은 지웁니다. */
export const courseConceptTags = pgTable(
  'course_concept_tags',
  {
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => conceptTags.id),
    addedBy: uuid('added_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'course_concept_tags_pkey', columns: [t.courseId, t.tagId] }),
    index('course_concept_tags_tag_id_idx').on(t.tagId),
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
    /**
     * 엠바고(§9.2). 학기를 연결하거나 바꿀 때마다 max(지금 값, 학기 종료·학기 엠바고)로만 올라가고,
     * 학기를 바꾸거나 떼어도 내려가지 않습니다(옛 학기로 바꿔 피하는 우회 방지). 낮추기는 운영자만(감사 기록).
     * 적용 엠바고는 이 값·지금 학기 종료·명시적 엠바고(embargoes)의 최댓값입니다(@peerchive/domain computeEffectiveEmbargo).
     */
    embargoUntil: timestamp('embargo_until', { withTimezone: true }),
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

// ── 연동·주간 체크인 (§6.1 Integration, §6.3 WeeklyCheckin, §12.1, T-09, ADR 0009) ──────────

/**
 * 외부 계정 연결. 디스코드는 사용자 id(snowflake)만 저장하고 토큰은 받지 않습니다(봇 토큰 하나로 동작).
 * 해제는 revoked_at을 채우며, 연결 중인(revoked_at null) 행은 (공급자, 외부 id)와 (사용자, 공급자)마다 하나입니다.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: integrationProvider('provider').notNull(),
    externalId: text('external_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('integrations_provider_external_active_key')
      .on(t.provider, t.externalId)
      .where(sql`${t.revokedAt} is null`),
    uniqueIndex('integrations_user_provider_active_key')
      .on(t.userId, t.provider)
      .where(sql`${t.revokedAt} is null`),
  ],
)

/**
 * 디스코드 일회용 코드(10분, 한 번만). 원문은 만든 응답에서 한 번만 보여 주고 SHA-256 해시만 저장합니다.
 * bind 코드는 프로젝트를 가리키고, 만든 사람(owner)의 디스코드 계정으로만 쓸 수 있습니다.
 */
export const discordCodes = pgTable(
  'discord_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: discordCodeKind('kind').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    projectId: uuid('project_id').references(() => projects.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('discord_codes_user_id_idx').on(t.userId),
    check('discord_codes_project_check', sql`(${t.kind} = 'bind') = (${t.projectId} is not null)`),
  ],
)

/**
 * 디스코드 채널 ↔ 프로젝트 연결. id만 저장하고 채널 이름(label)은 선택입니다.
 * 한 채널은 한 프로젝트에만 연결합니다(해제 전까지). 주간 요약 게시는 owner가 켤 때만(summary_enabled).
 */
export const discordChannelBindings = pgTable(
  'discord_channel_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    label: text('label'),
    summaryEnabled: boolean('summary_enabled').notNull().default(false),
    boundBy: uuid('bound_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    unboundAt: timestamp('unbound_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('discord_channel_bindings_channel_active_key')
      .on(t.channelId)
      .where(sql`${t.unboundAt} is null`),
    index('discord_channel_bindings_project_id_idx').on(t.projectId),
    check('discord_channel_bindings_label_check', sql`${t.label} is null or char_length(${t.label}) <= 100`),
  ],
)

/**
 * 남의 메시지에 단 📌의 승인 요청(48시간). 작성자가 승인해야 작성자 이름의 로그가 생깁니다.
 * content는 승인 전까지만 두고, 승인·거절·만료되면 null로 지웁니다(ADR 0009). 메시지마다 요청은 하나입니다.
 */
export const discordPinRequests = pgTable(
  'discord_pin_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => discordChannelBindings.id),
    messageId: text('message_id').notNull().unique(),
    channelId: text('channel_id').notNull(),
    authorExternalId: text('author_external_id').notNull(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id),
    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id),
    content: text('content'),
    status: pinRequestStatus('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    logEntryId: uuid('log_entry_id').references(() => logEntries.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('discord_pin_requests_pending_idx').on(t.expiresAt).where(sql`${t.status} = 'pending'`),
    // 결정·만료된 요청에는 메시지 내용이 남지 않습니다.
    check('discord_pin_requests_content_check', sql`${t.status} = 'pending' or ${t.content} is null`),
  ],
)

/**
 * 봇이 채널에 보낼 예약 알림(outbox). (연결, 종류, 주)마다 하나만 만들어 같은 주에 두 번 보내지 않습니다.
 * 봇이 가져가면 claimed_at(5분 임대)을 채우고, 보낸 뒤 delivered_at을 채웁니다.
 */
export const discordNotices = pgTable(
  'discord_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => discordChannelBindings.id),
    kind: discordNoticeKind('kind').notNull(),
    isoWeek: text('iso_week').notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** 보내지 못하고 포기했으면 짧은 이유(예: unreachable). */
    failedReason: text('failed_reason'),
    discordMessageId: text('discord_message_id'),
  },
  (t) => [
    unique('discord_notices_binding_kind_week_key').on(t.bindingId, t.kind, t.isoWeek),
    index('discord_notices_undelivered_idx').on(t.createdAt).where(sql`${t.deliveredAt} is null`),
    check('discord_notices_iso_week_check', sql`${t.isoWeek} ~ '^[0-9]{4}-W[0-9]{2}$'`),
  ],
)

/** 내부 API 요청 nonce(10분 기억, replay 방지). 오래된 행은 요청을 받을 때 지웁니다. */
export const internalRequestNonces = pgTable(
  'internal_request_nonces',
  {
    nonce: text('nonce').primaryKey(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('internal_request_nonces_received_at_idx').on(t.receivedAt)],
)

/**
 * 주간 체크인(60초 폼). (프로젝트, 사용자, 주)마다 하나이며 다시 내면 덮어씁니다(upsert).
 * 팀 안에서만 보이고(§6.4), 통계 공유(share_for_stats)는 따로 동의하며 기본은 꺼짐입니다(§11.2).
 * iso_week는 서울 날짜 기준 `YYYY-Www`입니다.
 */
export const weeklyCheckins = pgTable(
  'weekly_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    isoWeek: text('iso_week').notNull(),
    timeBucket: checkinTimeBucket('time_bucket').notNull(),
    difficulty: integer('difficulty').notNull(),
    note: text('note'),
    /** "이 한 줄을 빌드 로그로 옮기기"로 만든 로그(한 번만). */
    promotedLogEntryId: uuid('promoted_log_entry_id').references(() => logEntries.id),
    shareForStats: boolean('share_for_stats').notNull().default(false),
    /** 기록을 못 했거나 덜 한 이유(pilot-kit §3 6번, 복수). */
    skipReasons: text('skip_reasons').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('weekly_checkins_project_user_week_key').on(t.projectId, t.userId, t.isoWeek),
    index('weekly_checkins_project_week_idx').on(t.projectId, t.isoWeek),
    check('weekly_checkins_iso_week_check', sql`${t.isoWeek} ~ '^[0-9]{4}-W[0-9]{2}$'`),
    check('weekly_checkins_difficulty_check', sql`${t.difficulty} between 1 and 5`),
    check('weekly_checkins_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 200`),
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

/**
 * 명시적 엠바고(SYSTEM_DESIGN §6.6 Embargo). 프로젝트(owner 요청) 또는 개설 학기(운영자) 범위입니다.
 * 게시·공개 조회에서 강제하며(T-11/T-12의 assertPublishable), 끝나도 자동 공개하지 않습니다.
 * 해제는 revoked_at(운영자)이며 행을 지우지 않습니다.
 */
export const embargoes = pgTable(
  'embargoes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: embargoScope('scope').notNull(),
    projectId: uuid('project_id').references(() => projects.id),
    courseTermId: uuid('course_term_id').references(() => courseTerms.id),
    until: timestamp('until', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('embargoes_project_id_idx').on(t.projectId),
    index('embargoes_course_term_id_idx').on(t.courseTermId),
    check(
      'embargoes_scope_target_check',
      sql`(${t.scope} = 'project' and ${t.projectId} is not null and ${t.courseTermId} is null) or (${t.scope} = 'course_term' and ${t.courseTermId} is not null and ${t.projectId} is null)`,
    ),
    check('embargoes_reason_length_check', sql`char_length(${t.reason}) between 1 and 500`),
  ],
)
