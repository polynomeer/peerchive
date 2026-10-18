/**
 * 첫 vertical slice 스키마 (SYSTEM_DESIGN §6.1–§6.3 일부).
 *
 * 범위: 신원·프로필, 강의 아카이브 골격(학교·과목·학기), 과제 공간·멤버·초대, 빌드 로그(revision).
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
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_private_email_lower_key').on(sql`lower(${t.privateEmail})`)],
)

export const profiles = pgTable('profiles', {
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
})

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_owner_id_idx').on(t.ownerId), index('projects_course_term_id_idx').on(t.courseTermId)],
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
    /** 첫 revision 저장 전에는 null. log_revisions와 순환 참조이므로 아래 foreignKey로 선언합니다. */
    currentRevisionId: uuid('current_revision_id'),
    source: logSource('source').notNull().default('web'),
    createdAt: createdAt(),
  },
  (t) => [
    index('log_entries_project_id_idx').on(t.projectId),
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
    /** 학생이 기입한 수행일(자기 주장). */
    claimedDate: date('claimed_date'),
    /** 플랫폼 기록 시각. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    /** AI 생성물은 학생 승인 전까지 초안입니다. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => [
    unique('log_revisions_log_entry_id_revision_no_key').on(t.logEntryId, t.revisionNo),
    check('log_revisions_revision_no_check', sql`${t.revisionNo} >= 1`),
    check('log_revisions_payload_object_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
    index('log_revisions_resolves_entry_id_idx').on(t.resolvesEntryId),
  ],
)
