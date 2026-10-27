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
 * T-11(0009 migration): 공개(publications)·공개 후보(publication_candidates: 공개 스냅샷·manifest·해시·점검 경고)·
 * 동의(consents, 후보·manifest 해시에 묶임). 결정은 ADR 0011. 게시·철회·공개 조회는 T-12입니다.
 * T-12(0010 migration): 게시·철회 열(publications.access_epoch·first_published_at·withdrawn_*,
 * publication_candidates.release_no·published_at·replaced_at·withdrawn_at, 후보 상태 replaced), 공개 release는 공개마다 하나.
 * 결정은 ADR 0012.
 * T-13(0012 migration): 공개 release의 과목 연결(publication_candidates.course_id·term_label, 게시 때 정본 과목으로 기록),
 * 선배 노트(senior_notes), 유용성 신호(usefulness_signals), 플랜 포크(plan_forks), 검색 문서(search_documents, 파생 데이터).
 * 결정은 ADR 0013.
 * T-14(0013 migration): 케이스 스터디(case_studies, 게시된 release 하나에 고정)·문장(case_sentences, 문장마다 스냅샷 인용),
 * 포트폴리오 판(portfolio_editions, 만든 뒤 바꾸지 않음)·대표 사례(portfolio_items)·역량 근거(competency_evidence, 점수 없음).
 * 결정은 ADR 0014.
 * T-15(0014 migration): 신고(reports)·운영 조치(moderation_actions)·가린 항목(release_hidden_items)·보류(holds)·이의제기(appeals),
 * 케이스 스터디·공개 프로필의 운영 숨김(case_studies.hidden_at·profiles.hidden_at). 결정은 ADR 0015.
 * T-16(0015 migration): 탈퇴 계정 정리(users.purged_at)·삭제 장부(deletion_ledger, 개인정보 없음), 분석 수집 거부(users.analytics_opt_out),
 * pilot 분석 이벤트(analytics_events, 허용 목록 props만), worker 상태 기록(worker_heartbeats). 결정은 ADR 0016.
 * C-01(0016 migration): 학교 메일 도메인(school_email_domains, 운영자 등록), 기관 소속 인증(institution_affiliations: 메일 주소 대신
 * HMAC·도메인만, 자기 신고 학과·재학/졸업생, 상태 이력)과 인증 코드(affiliation_codes, HMAC·10분·5회), 공개 프로필 배지 선택
 * (profiles.show_affiliation_badge), 분석 이벤트 affiliation_verified. 결정은 ADR 0018.
 * C-02(0017 migration): 커뮤니티 공간(community_spaces: 공식 학교·학과 페이지·사용자 방·스터디 방)·멤버십(space_memberships)·게시판(boards)·
 * 초대(space_invitations, 해시·7일·일회성)·공식 페이지 개설 요청(official_page_requests), 신고 대상 community_space·조치 restrict_space,
 * 분석 이벤트 space_created·space_joined. 결정은 ADR 0019.
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
/** 공개 상태(SYSTEM_DESIGN §7.2). 전이 규칙은 @peerchive/domain의 transition(PUBLICATION_STATES와 같은 값)입니다. */
export const publicationStatus = pgEnum('publication_status', [
  'draft',
  'embargoed',
  'awaiting_consent',
  'ready',
  'published',
  'withdrawn',
  'restricted',
])
/** 공개 수준(PROOFU_EVOLUTION_PLAN §9.1): 요약(산출물 본문 제외) / 전체. */
export const publicationLevel = pgEnum('publication_level', ['summary', 'full'])
/**
 * 공개 후보 상태. 열린 후보는 awaiting_consent/ready 중 하나이고, 새 후보를 만들면 이전 후보는 superseded가 됩니다.
 * published/withdrawn/replaced는 T-12(게시·철회)가 씁니다: 게시하면 같은 행이 release가 되고 스냅샷은 바뀌지 않습니다.
 * 새 release를 게시하면 이전 release는 replaced(더 이상 제공하지 않음), 철회하면 withdrawn입니다.
 */
export const candidateStatus = pgEnum('candidate_status', [
  'awaiting_consent',
  'ready',
  'superseded',
  'published',
  'withdrawn',
  'replaced',
])
/** 동의 상태(@peerchive/domain ConsentStatus). revoked는 게시 후 동의 철회(T-12)용입니다. */
export const consentStatus = pgEnum('consent_status', ['pending', 'granted', 'declined', 'revoked'])
/** 선배 노트 작성자 표시(@peerchive/domain SENIOR_NOTE_DISPLAY_MODES): 계정 이름 / 직접 입력한 표시명 / 익명("익명 선배"). */
export const seniorNoteDisplayMode = pgEnum('senior_note_display_mode', ['name', 'display', 'anonymous'])
/** 선배 노트 상태. hidden은 운영자 조치용(T-15, 지금은 API 없음). 공개 조회는 published만 봅니다. */
export const seniorNoteStatus = pgEnum('senior_note_status', ['draft', 'published', 'withdrawn', 'hidden'])
/** 선배 노트의 대략 총 소요 시간(supply-kit §2): ~10h / ~20h / ~40h / 40h+. */
export const seniorNoteTimeBucket = pgEnum('senior_note_time_bucket', ['lt10h', 'lt20h', 'lt40h', 'forty_plus'])
/** 유용성 신호의 대상: 공개 사례의 막힘 카드(공개·로그 키) / 게시된 선배 노트. */
export const signalTargetKind = pgEnum('signal_target_kind', ['stuck_item', 'senior_note'])
/** 유용성 신호 종류: 나도 여기서 막혔어요 / 도움됐어요. */
export const signalKind = pgEnum('signal_kind', ['me_too', 'helped'])
/** 검색 문서 종류(파생 데이터): 공개 사례 / 막힘 카드 / 선배 노트. */
export const searchDocKind = pgEnum('search_doc_kind', ['case', 'stuck', 'note'])
/** 케이스 스터디 지원 직무(T-14). */
export const caseJobTarget = pgEnum('case_job_target', ['backend', 'frontend', 'data', 'pm', 'design', 'general'])
/** 케이스 스터디 상태(T-14): 초안 → 게시 → (원본 release 철회·대체 시) 이용 불가. 이용 불가는 되돌리지 않습니다. */
export const caseStudyStatus = pgEnum('case_study_status', ['draft', 'published', 'unavailable'])
/** 신고 대상(T-15, @peerchive/domain REPORT_TARGET_TYPES). 지금 공개인 것만 신고할 수 있습니다(community_space는 신고자가 읽을 수 있는 공간, C-02). */
export const reportTargetType = pgEnum('report_target_type', ['publication', 'publication_item', 'senior_note', 'case_study', 'profile', 'community_space'])
/** 신고 사유(T-15, REPORT_REASONS). 개인정보·저작권은 공개 사례에 보류를 겁니다. */
export const reportReason = pgEnum('report_reason', ['personal_info', 'answer_sharing', 'copyright', 'harassment', 'false_claim', 'spam', 'other'])
/** 신고 상태(T-15): 접수 → 검토 중 → 처리됨/기각. 닫힌 신고는 다시 열지 않습니다. */
export const reportStatus = pgEnum('report_status', ['open', 'in_review', 'resolved', 'dismissed'])
/** 운영 조치 종류(T-15, MODERATION_ACTION_KINDS). 모두 공개 차단이며 삭제는 없습니다. */
export const moderationActionKind = pgEnum('moderation_action_kind', ['none', 'restrict', 'hide_item', 'hide_note', 'hide_case_study', 'hide_profile', 'restrict_space'])
/** 공개 사례 안에서 가릴 수 있는 항목(T-15, HIDDEN_ITEM_KINDS). */
export const hiddenItemKind = pgEnum('hidden_item_kind', ['log', 'claim', 'artifact'])
/** 이의제기 상태(T-15): 열림 → 유지/되돌림. */
export const appealStatus = pgEnum('appeal_status', ['open', 'upheld', 'reversed'])
/** pilot 분석 이벤트 이름(T-16, DELIVERY_PLAN §6 + login_succeeded, @peerchive/domain ANALYTICS_EVENT_NAMES와 같은 값). */
export const analyticsEventName = pgEnum('analytics_event_name', [
  'project_created',
  'log_saved',
  'evidence_attached',
  'milestone_snapshot_set',
  'checkin_submitted',
  'claim_endorsed',
  'report_exported',
  'candidate_prepared',
  'consent_completed',
  'publication_published',
  'publication_withdrawn',
  'plan_forked',
  'usefulness_marked',
  'senior_note_published',
  'portfolio_shared',
  'login_succeeded',
  'affiliation_verified',
  'space_created',
  'space_joined',
])
/** 기관 종류(C-01). 지금은 대학만. P2에서 bootcamp 등을 더합니다(SYSTEM_DESIGN §6.7.2 이관 원칙, ADR 0018). */
export const institutionKind = pgEnum('institution_kind', ['university'])
/** 소속 인증 수단(C-01). 지금은 학교 메일만. P2에서 invite_code·cohort_approval·certificate_check를 더합니다. */
export const affiliationMethod = pgEnum('affiliation_method', ['email'])
/** 재학생/졸업생(자기 선언). 재학생 → 졸업생으로만 바꿀 수 있습니다. */
export const affiliationStanding = pgEnum('affiliation_standing', ['student', 'alumni'])
/** pending(코드 대기) → active(인증) / expired(만료·시도 초과·새 요청으로 대체) / revoked(본인 해제·운영자 취소). */
export const affiliationStatus = pgEnum('affiliation_status', ['pending', 'active', 'revoked', 'expired'])
/** 커뮤니티 공간 종류(C-02, @peerchive/domain SPACE_KINDS). official_*는 운영자만 만듭니다. */
export const communitySpaceKind = pgEnum('community_space_kind', ['official_school', 'official_department', 'user_room', 'study_room'])
/** 공간의 이름 표시 방식(실명·표시명·익명). 공식 페이지는 anonymous 고정. 바꾸기는 C-03(7일 예약). */
export const communityNameMode = pgEnum('community_name_mode', ['real', 'display', 'anonymous'])
/** 찾기: 목록에 노출 / 링크·초대로만. */
export const spaceDiscovery = pgEnum('space_discovery', ['listed', 'unlisted'])
/** 가입 방식: 자유 / 방장 승인 / 초대 전용. */
export const spaceJoinPolicy = pgEnum('space_join_policy', ['open', 'approval', 'invite'])
/** 공간 상태: active / archived(보관, 읽기만) / restricted(운영 조치, 읽기만·운영자만 해제). */
export const spaceStatus = pgEnum('space_status', ['active', 'archived', 'restricted'])
/** 공간 역할(과제 역할과 별개). */
export const spaceRole = pgEnum('space_role', ['owner', 'admin', 'moderator', 'member'])
/** 멤버십 상태: pending(승인 대기) / active / left(나감) / removed(내보냄·승인 거절·학과 쓰기 제한). */
export const spaceMembershipStatus = pgEnum('space_membership_status', ['pending', 'active', 'left', 'removed'])
/** 게시판 종류(§6.7 Board). */
export const boardKind = pgEnum('board_kind', ['free', 'freshmen', 'alumni', 'question', 'info', 'recruiting', 'notice', 'general'])
/** 게시판 쓰기 역할: member / moderator(공지 등). */
export const boardWriteRole = pgEnum('board_write_role', ['member', 'moderator'])
/** 공식 페이지 개설 요청 출처: 학생 / 학생회(운영자가 확인해 표시). */
export const officialRequestSource = pgEnum('official_request_source', ['student', 'student_council'])

// ── 신원·프로필 (§6.1) ───────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    /** 로그인·알림용. 공개 DTO에 싣지 않습니다. */
    privateEmail: text('private_email').notNull(),
    status: userStatus('status').notNull().default('active'),
    /** 탈퇴 요청 시각. 요청 즉시 status='deleted'로 바꾸고, 실제 삭제(purge)는 유예 기간 뒤 worker 작업입니다(T-16, ADR 0016). */
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    /**
     * 정리(purge)를 마친 시각(T-16). 이때 표시 이름은 "탈퇴한 사용자", 이메일은 자리표시 주소로 바뀌고 프로필·세션·로그인 수단·연동·체크인·
     * 신호·선배 노트·케이스·포트폴리오·혼자 쓴 과제가 지워집니다. 팀 기록이 이 행을 가리키므로 행 자체는 남깁니다(ADR 0016).
     */
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    /** pilot 분석 이벤트 수집 거부(T-16). true면 이 사용자를 주체로 하는 이벤트를 만들지 않습니다(설정 화면). */
    analyticsOptOut: boolean('analytics_opt_out').notNull().default(false),
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
    /** 운영 조치로 공개 프로필을 숨긴 시각(T-15). 숨김이면 /u/:handle·README 카드·이전 공개 프로필 API가 404입니다. 계정·과제 공간은 그대로입니다. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    /** 공개 프로필에 학교 인증 배지("○○대학교 인증", 졸업생이면 "졸업생")를 보일지(C-01, 기본 끔). 학과·메일·도메인은 어떤 경우에도 공개하지 않습니다. */
    showAffiliationBadge: boolean('show_affiliation_badge').notNull().default(false),
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
 * 학교 메일 인증(C-01)은 school_email_domains·institution_affiliations가 이 행을 가리킵니다(ADR 0018). 공식 페이지(§8.9.3)는 아직 없습니다.
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
    /**
     * 이미지 메타데이터(EXIF/GPS/XMP/주석)를 지운 내용이 clean 키에 있는지(ADR 0007 "메타데이터 제거"). PDF는 고쳐 쓰지 않으므로 false.
     * 이 열이 생기기 전에 clean이 된 이미지는 false이고, backfill(`pnpm --filter worker backfill-strip`) 전까지 공개에 쓰지 않습니다.
     */
    metadataStripped: boolean('metadata_stripped').notNull().default(false),
    /** clean 키에 있는(내려주는) 내용의 SHA-256·크기. 원래 sha256·bytes는 같은 내용 중복 판단과 저장 한도에 그대로 씁니다. */
    strippedSha256: text('stripped_sha256'),
    strippedBytes: bigint('stripped_bytes', { mode: 'number' }),
    /** 메타데이터 처리 결과(@peerchive/domain MetadataFindings). 이미지는 지운 종류, PDF는 속성 이름 + 가린 표본(값 전체 없음). */
    metadataFindings: jsonb('metadata_findings').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('artifact_versions_artifact_id_version_no_key').on(t.artifactId, t.versionNo),
    unique('artifact_versions_artifact_id_sha256_key').on(t.artifactId, t.sha256),
    index('artifact_versions_uploader_id_idx').on(t.uploaderId),
    check('artifact_versions_version_no_check', sql`${t.versionNo} >= 1`),
    check('artifact_versions_bytes_check', sql`${t.bytes} >= 0`),
    check('artifact_versions_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('artifact_versions_stripped_sha256_check', sql`${t.strippedSha256} is null or ${t.strippedSha256} ~ '^[0-9a-f]{64}$'`),
    check('artifact_versions_stripped_bytes_check', sql`${t.strippedBytes} is null or ${t.strippedBytes} >= 0`),
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

// ── 공개·동의 (§6.5, §7.2, T-11, ADR 0011) ───────────────────────────────

/**
 * 공개(프로젝트당 하나). 안정된 URL(slug)과 공개 상태를 가집니다. 첫 공개 후보를 만들 때 생깁니다.
 * slug는 처음 게시하기 전에는 새 후보마다 바꿀 수 있고, 한 번 게시한 뒤에는 고정됩니다(T-12). 전체에서 유일합니다.
 * current_release_id는 마지막으로 게시한 후보(release)를 가리킵니다. 철회해도 이력으로 남지만, 공개 조회는
 * status = 'published'이고 그 release도 published일 때만 내용을 돌려줍니다.
 * access_epoch는 공개로 제공하는 것이 바뀔 때마다(게시·철회·동의 철회) 1씩 올립니다. 파일 ETag·캐시 키에 넣어
 * 철회가 콘텐츠 캐시보다 우선하게 합니다(SYSTEM_DESIGN §11).
 */
export const publications = pgTable(
  'publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .unique()
      .references(() => projects.id),
    slug: text('slug').notNull().unique(),
    level: publicationLevel('level').notNull(),
    status: publicationStatus('status').notNull().default('draft'),
    /** 게시된 release(publication_candidates 행). 순환 참조라 아래 foreignKey로 선언합니다. */
    currentReleaseId: uuid('current_release_id'),
    accessEpoch: integer('access_epoch').notNull().default(0),
    firstPublishedAt: timestamp('first_published_at', { withTimezone: true }),
    /** 마지막 철회 시각·원인(owner 철회 / 당사자 동의 철회)·owner 메모. 다시 게시하면 비웁니다. 공개 응답에 싣지 않습니다. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawCause: text('withdraw_cause'),
    withdrawNote: text('withdraw_note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    check('publications_slug_format_check', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${t.slug}) between 3 and 60`),
    check('publications_access_epoch_check', sql`${t.accessEpoch} >= 0`),
    check('publications_withdraw_cause_check', sql`${t.withdrawCause} is null or ${t.withdrawCause} in ('owner', 'consent_revoked')`),
    check('publications_withdraw_note_check', sql`${t.withdrawNote} is null or char_length(${t.withdrawNote}) between 1 and 300`),
    foreignKey({
      name: 'publications_current_release_id_fk',
      columns: [t.currentReleaseId],
      foreignColumns: [publicationCandidates.id],
    }),
  ],
)

/**
 * 공개 후보(= 게시되면 release). 만든 뒤 snapshot·manifest·manifest_hash는 바꾸지 않습니다(새 후보를 만듦).
 * - snapshot: 공개 페이지가 그대로 보여 줄 공개 DTO 전체(buildPublicSnapshot의 결과). 공개 경로(T-12)는 이것만 읽습니다.
 * - manifest: 고정한 revision·버전·마일스톤 version·노출 이름·사용 조건·제외한 사람 + snapshot 다이제스트.
 *   manifest_hash = sha256(canonicalJson(manifest)). 동의는 이 해시에 묶입니다.
 * - selection: 요청을 정규화한 값(비공개, 미동의자 제외 후보·화면 채우기용). refs: 스냅샷 키 → 비공개 id(고치기 링크용).
 * - checks: 공개 전 점검 경고(가린 표본만). subject_digests: 동의 당사자별 자기 관련 부분의 다이제스트(동의 이어받기 판정).
 * 열린 후보(awaiting_consent/ready)는 공개마다 하나입니다(부분 unique).
 */
export const publicationCandidates = pgTable(
  'publication_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicationId: uuid('publication_id')
      .notNull()
      .references((): AnyPgColumn => publications.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** 공개 안에서 1부터 늘어나는 번호(release version). */
    version: integer('version').notNull(),
    level: publicationLevel('level').notNull(),
    status: candidateStatus('status').notNull().default('awaiting_consent'),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    manifestHash: text('manifest_hash').notNull(),
    selection: jsonb('selection').$type<Record<string, unknown>>().notNull(),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    checks: jsonb('checks').$type<Array<Record<string, unknown>>>().notNull().default([]),
    subjectDigests: jsonb('subject_digests').$type<Record<string, string>>().notNull().default({}),
    /** 미동의자 제외로 만든 후보면 원래 후보. */
    derivedFromId: uuid('derived_from_id').references((): AnyPgColumn => publicationCandidates.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /** 공개 안에서 게시 순서(1부터, 공개 화면의 "공개 버전 vN"). 게시한 후보만 가집니다. */
    releaseNo: integer('release_no'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** 새 release가 게시되어 이 release를 더 이상 제공하지 않게 된 시각. */
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    /** 이 release(또는 그때 열려 있던 후보)를 철회한 시각. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    /**
     * 게시 때 기록한 과목 허브 연결(T-13): 스냅샷에 과목이 있고 프로젝트의 학기가 같은 (연도, 학기)일 때 그 학기의 정본 과목.
     * 운영자가 과목을 병합하면 같은 트랜잭션에서 정본으로 옮깁니다(merge.ts). 공개 응답에 내부 학기 id는 싣지 않습니다.
     */
    courseId: uuid('course_id').references(() => courses.id),
    /** 게시 때의 학기 표시(예: "2026년 1학기", 스냅샷의 연도·학기에서 만듦). */
    termLabel: text('term_label'),
  },
  (t) => [
    unique('publication_candidates_publication_version_key').on(t.publicationId, t.version),
    // 과목 허브: 과목별 지금 게시 중인 release.
    index('publication_candidates_course_published_idx').on(t.courseId).where(sql`${t.status} = 'published'`),
    unique('publication_candidates_publication_release_key').on(t.publicationId, t.releaseNo),
    uniqueIndex('publication_candidates_open_key')
      .on(t.publicationId)
      .where(sql`${t.status} in ('awaiting_consent', 'ready')`),
    // 지금 제공하는 release는 공개마다 하나뿐입니다.
    uniqueIndex('publication_candidates_published_key')
      .on(t.publicationId)
      .where(sql`${t.status} = 'published'`),
    check('publication_candidates_release_check', sql`(${t.releaseNo} is null) = (${t.publishedAt} is null) and (${t.releaseNo} is null or ${t.releaseNo} >= 1)`),
    index('publication_candidates_project_id_idx').on(t.projectId),
    check('publication_candidates_version_check', sql`${t.version} >= 1`),
    check('publication_candidates_manifest_hash_check', sql`${t.manifestHash} ~ '^[0-9a-f]{64}$'`),
    check('publication_candidates_snapshot_object_check', sql`jsonb_typeof(${t.snapshot}) = 'object'`),
    check('publication_candidates_manifest_object_check', sql`jsonb_typeof(${t.manifest}) = 'object'`),
    check('publication_candidates_superseded_check', sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`),
  ],
)

/**
 * 동의(후보·당사자마다 하나). manifest_hash는 만들 때 후보의 해시를 복사하며, 결정 요청의 해시가 다르면 거부합니다.
 * 당사자는 이름·로그·역할 선언·회의 참석·올린 파일이 공개 범위에 든 사람(나간 멤버 포함)과 후보를 만든 사람입니다.
 * scope는 그 사람과 관련해 포함된 것(name, logs, meetings, claims, artifacts, title_summary).
 * 후보를 만든 사람의 동의는 요청에서 명시적으로 체크했을 때만 granted로 만듭니다(조용한 자기 동의 없음).
 * carried_from_candidate_id: 미동의자 제외 후보에서 자기 관련 부분이 그대로라 이어받은 동의의 원래 후보.
 */
export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => publicationCandidates.id),
    manifestHash: text('manifest_hash').notNull(),
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id),
    scope: text('scope').array().notNull().default(sql`'{}'::text[]`),
    status: consentStatus('status').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note'),
    carriedFromCandidateId: uuid('carried_from_candidate_id').references(() => publicationCandidates.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('consents_candidate_subject_key').on(t.candidateId, t.subjectUserId),
    index('consents_subject_status_idx').on(t.subjectUserId, t.status),
    check('consents_manifest_hash_check', sql`${t.manifestHash} ~ '^[0-9a-f]{64}$'`),
    check('consents_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 300`),
    check('consents_decided_check', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
  ],
)

// ── 과목 허브 (§6.2 SeniorNote·PlanFork·UsefulnessSignal, §11, T-13, ADR 0013) ─────────────

/**
 * 선배 노트(과목을 마친 학생이 남기는 질문형 회고). 공개 사례 없이도 쓸 수 있습니다.
 * - answers: {firstWeek, timeSink, differently, wishKnew} 각 1000자 이하, 비어 있지 않은 답 2개 이상(@peerchive/domain normalizeSeniorNoteAnswers).
 * - display_name_snapshot: name이면 게시 때의 계정 이름, display면 작성자가 입력한 표시명, anonymous면 null("익명 선배").
 *   작성자(author_id)는 공개 응답에 싣지 않고 운영자는 감사 기록으로만 압니다.
 * - 공개 조회는 status = 'published'만 읽습니다. 게시한 노트를 고치면 draft로 돌아가 다시 게시해야 합니다(점검을 다시 거침).
 * - 정답·답안·교수 개인 평가가 없다는 확인(no_answers_confirmed)은 만들 때 필수입니다.
 */
export const seniorNotes = pgTable(
  'senior_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 정본 과목. 과목 병합 때 정본으로 옮깁니다. */
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    displayMode: seniorNoteDisplayMode('display_mode').notNull(),
    displayNameSnapshot: text('display_name_snapshot'),
    termLabel: text('term_label'),
    totalTimeBucket: seniorNoteTimeBucket('total_time_bucket'),
    answers: jsonb('answers').$type<Record<string, string>>().notNull(),
    noAnswersConfirmed: boolean('no_answers_confirmed').notNull(),
    status: seniorNoteStatus('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** 낙관적 동시성. 내용을 고칠 때마다 1씩 올립니다(게시·철회는 올리지 않음). */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('senior_notes_course_published_idx').on(t.courseId, t.publishedAt.desc()).where(sql`${t.status} = 'published'`),
    index('senior_notes_author_id_idx').on(t.authorId),
    check('senior_notes_answers_object_check', sql`jsonb_typeof(${t.answers}) = 'object'`),
    check('senior_notes_confirmed_check', sql`${t.noAnswersConfirmed}`),
    check('senior_notes_version_check', sql`${t.version} >= 1`),
    check(
      'senior_notes_display_name_check',
      sql`${t.displayNameSnapshot} is null or char_length(${t.displayNameSnapshot}) between 1 and 80`,
    ),
    check('senior_notes_term_label_check', sql`${t.termLabel} is null or char_length(${t.termLabel}) between 1 and 30`),
    check('senior_notes_published_check', sql`${t.status} <> 'published' or ${t.publishedAt} is not null`),
  ],
)

/**
 * 유용성 신호("나도 여기서 막혔어요"·"도움됐어요"). 사용자·대상·종류마다 하나. 항목별 개수로만 쓰고 작성자별로 합산하지 않습니다.
 * 대상: 막힘 카드(publication_id + 스냅샷 로그 키, 키는 공개마다 안정됨) 또는 선배 노트. 대상이 지금 공개일 때만 남길 수 있고,
 * 읽기는 지금 공개인 대상만 셉니다. 철회되면 worker 정리 handler가 지웁니다(늦어도 읽기에는 보이지 않음).
 */
export const usefulnessSignals = pgTable(
  'usefulness_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    targetKind: signalTargetKind('target_kind').notNull(),
    publicationId: uuid('publication_id').references(() => publications.id),
    itemKey: text('item_key'),
    seniorNoteId: uuid('senior_note_id').references(() => seniorNotes.id),
    kind: signalKind('kind').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('usefulness_signals_stuck_key')
      .on(t.userId, t.publicationId, t.itemKey, t.kind)
      .where(sql`${t.targetKind} = 'stuck_item'`),
    uniqueIndex('usefulness_signals_note_key')
      .on(t.userId, t.seniorNoteId, t.kind)
      .where(sql`${t.targetKind} = 'senior_note'`),
    index('usefulness_signals_publication_idx').on(t.publicationId, t.itemKey),
    index('usefulness_signals_note_idx').on(t.seniorNoteId),
    check(
      'usefulness_signals_target_check',
      sql`(${t.targetKind} = 'stuck_item' and ${t.publicationId} is not null and ${t.itemKey} is not null and ${t.seniorNoteId} is null)
        or (${t.targetKind} = 'senior_note' and ${t.seniorNoteId} is not null and ${t.publicationId} is null and ${t.itemKey} is null)`,
    ),
    check('usefulness_signals_item_key_check', sql`${t.itemKey} is null or char_length(${t.itemKey}) between 1 and 40`),
  ],
)

/**
 * 플랜 포크 기록. 포크로 만든 프로젝트는 포크한 사람의 비공개 과제 공간이고, 공개 스냅샷의 계획 요소(마일스톤 이름·순서·상대 일수,
 * 참고 링크)만 복사합니다(@peerchive/domain forkPlanFromSnapshot). (원본 공개, 사용자)마다 하나: 같은 사람이 다시 포크하면
 * 기존 프로젝트를 돌려줍니다. 포크 수 = 이 테이블의 행 수(= 서로 다른 사용자 수).
 * 원본이 철회돼도 이 행과 복사된 계획은 포크한 사람의 데이터로 남고, 원본 링크는 공개 조회 규칙대로 끊깁니다(§11).
 */
export const planForks = pgTable(
  'plan_forks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourcePublicationId: uuid('source_publication_id')
      .notNull()
      .references(() => publications.id),
    sourceReleaseId: uuid('source_release_id')
      .notNull()
      .references(() => publicationCandidates.id),
    /** 포크한 공개 버전(release_no). */
    releaseVersion: integer('release_version').notNull(),
    targetProjectId: uuid('target_project_id')
      .notNull()
      .unique()
      .references(() => projects.id),
    forkedBy: uuid('forked_by')
      .notNull()
      .references(() => users.id),
    /** 복사한 것의 개수만({milestones, references}). */
    copied: jsonb('copied').$type<Record<string, number>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique('plan_forks_source_user_key').on(t.sourcePublicationId, t.forkedBy),
    index('plan_forks_forked_by_idx').on(t.forkedBy),
    check('plan_forks_release_version_check', sql`${t.releaseVersion} >= 1`),
  ],
)

/**
 * 공개 검색 문서(파생 데이터, SYSTEM_DESIGN §11.1). worker가 게시 이벤트에서 만들고 철회·대체·노트 철회 때 지웁니다.
 * **편의용 사본일 뿐이며 공개 여부의 근거가 아닙니다**: 검색 쿼리는 항상 공개·release·노트 행과 조인해 지금 게시 상태와 엠바고를
 * 같은 쿼리에서 확인하므로, 정리가 늦어 남은 행이 있어도 철회된 내용은 나오지 않습니다.
 * - case/stuck: release_id(그 release 스냅샷에서 만든 문서). 지금 release와 같을 때만 검색됩니다.
 * - note: senior_note_id + note_version(그 버전에서 만든 문서). 노트가 published이고 버전이 같을 때만 검색됩니다.
 */
export const searchDocuments = pgTable(
  'search_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: searchDocKind('kind').notNull(),
    publicationId: uuid('publication_id').references(() => publications.id),
    releaseId: uuid('release_id').references(() => publicationCandidates.id),
    itemKey: text('item_key'),
    seniorNoteId: uuid('senior_note_id').references(() => seniorNotes.id),
    noteVersion: integer('note_version'),
    title: text('title').notNull(),
    snippet: text('snippet').notNull(),
    /** 정규화한 검색 대상 글(@peerchive/domain normalizeSearchText). */
    searchText: text('search_text').notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('search_documents_case_key').on(t.releaseId).where(sql`${t.kind} = 'case'`),
    uniqueIndex('search_documents_stuck_key').on(t.releaseId, t.itemKey).where(sql`${t.kind} = 'stuck'`),
    uniqueIndex('search_documents_note_key').on(t.seniorNoteId).where(sql`${t.kind} = 'note'`),
    index('search_documents_publication_idx').on(t.publicationId),
    index('search_documents_search_text_trgm_idx').using('gin', t.searchText.op('gin_trgm_ops')),
    check(
      'search_documents_target_check',
      sql`(${t.kind} in ('case', 'stuck') and ${t.publicationId} is not null and ${t.releaseId} is not null and ${t.seniorNoteId} is null
          and ((${t.kind} = 'case') = (${t.itemKey} is null)))
        or (${t.kind} = 'note' and ${t.seniorNoteId} is not null and ${t.noteVersion} is not null and ${t.publicationId} is null and ${t.releaseId} is null)`,
    ),
  ],
)

// ── 포트폴리오 (§6.5 CaseStudy·CaseSentence·PortfolioEdition·PortfolioItem·CompetencyEvidence, §11, T-14, ADR 0014) ─────

/**
 * 케이스 스터디. 게시된 release 하나(release_id, 그 공개 버전 release_version)에 고정되며, 그 release 스냅샷에 팀원 키(member_key)로
 * 들어 있는 사람만 만들 수 있습니다. 공개 읽기는 이 행의 상태만 믿지 않고 요청마다 그 release가 지금도 제공 가능한지
 * (servableReleaseSql) 확인합니다. 철회·대체되면 worker 정리 handler가 unavailable로 표시합니다(늦어도 읽기에는 보이지 않음).
 * - reveal_self: 스냅샷에서 익명이던 사람이 자기 이름(프로필)과 연결하겠다고 확인했는지. 다른 팀원은 스냅샷 그대로입니다.
 * - title·문장은 스냅샷 글로 만든 초안 + 사용자가 고친 글입니다. 비공개 작업 테이블의 글을 넣지 않습니다.
 */
export const caseStudies = pgTable(
  'case_studies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publications.id),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => publicationCandidates.id),
    releaseVersion: integer('release_version').notNull(),
    /** 스냅샷 안의 이 사람 가명 키(공개마다 안정됨). */
    memberKey: text('member_key').notNull(),
    selfAnonymous: boolean('self_anonymous').notNull(),
    revealSelf: boolean('reveal_self').notNull().default(false),
    jobTarget: caseJobTarget('job_target').notNull(),
    /** 초안 생성 방식. MVP는 template만(AI 다듬기는 P1). */
    generator: text('generator').notNull().default('template'),
    title: text('title').notNull(),
    status: caseStudyStatus('status').notNull().default('draft'),
    version: integer('version').notNull().default(1),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    unavailableAt: timestamp('unavailable_at', { withTimezone: true }),
    /** withdrawn(원본 공개 철회) / replaced(새 공개 버전으로 대체). */
    unavailableReason: text('unavailable_reason'),
    /** 운영 조치로 숨긴 시각(T-15). 숨김이면 공개 경로에 나오지 않고 다시 게시할 수 없습니다(이의제기로 되돌리면 null). 상태(status)와 별개입니다. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('case_studies_user_id_idx').on(t.userId),
    index('case_studies_publication_id_idx').on(t.publicationId),
    index('case_studies_release_id_idx').on(t.releaseId),
    check('case_studies_generator_check', sql`${t.generator} in ('template')`),
    check('case_studies_title_check', sql`char_length(${t.title}) between 1 and 80`),
    check('case_studies_version_check', sql`${t.version} >= 1`),
    check('case_studies_release_version_check', sql`${t.releaseVersion} >= 1`),
    check('case_studies_reveal_check', sql`not ${t.selfAnonymous} or ${t.revealSelf}`),
    check('case_studies_published_check', sql`${t.status} <> 'published' or ${t.publishedAt} is not null`),
    check(
      'case_studies_unavailable_check',
      sql`(${t.status} = 'unavailable') = (${t.unavailableAt} is not null) and (${t.unavailableReason} is null or ${t.unavailableReason} in ('withdrawn', 'replaced'))`,
    ),
  ],
)

/**
 * 케이스 스터디 문장. 구역(section)·구역 안 순서(position)·글·종류(evidence/reflection)·인용(citations: 고정한 release 스냅샷 안의
 * {releaseVersion, kind, key} 목록). 인용 없는 문장은 초안에 둘 수 있지만 게시는 막히고, 한계·회고 구역의 reflection(본인 회고)만 예외입니다.
 * 편집은 케이스의 문장 전체를 바꿉니다(케이스 version 증가).
 */
export const caseSentences = pgTable(
  'case_sentences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseStudyId: uuid('case_study_id')
      .notNull()
      .references(() => caseStudies.id),
    section: text('section').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    kind: text('kind').notNull().default('evidence'),
    citations: jsonb('citations').$type<Array<Record<string, unknown>>>().notNull().default([]),
  },
  (t) => [
    unique('case_sentences_position_key').on(t.caseStudyId, t.section, t.position),
    check(
      'case_sentences_section_check',
      sql`${t.section} in ('problem_result', 'my_role', 'decisions', 'stuck_solved', 'validation', 'limits', 'sources')`,
    ),
    check('case_sentences_kind_check', sql`${t.kind} in ('evidence', 'reflection') and (${t.kind} = 'evidence' or ${t.section} = 'limits')`),
    check('case_sentences_text_check', sql`char_length(${t.text}) between 1 and 500`),
    check('case_sentences_position_check', sql`${t.position} >= 0`),
    check('case_sentences_citations_array_check', sql`jsonb_typeof(${t.citations}) = 'array'`),
  ],
)

/**
 * 포트폴리오 판. 만들 때마다 새 version(사용자마다 1부터)이고 만든 뒤 바꾸지 않습니다. 사용자마다 지금 판(current)은 하나이며
 * 공개 프로필은 지금 판만 보여 줍니다(이전 판은 남지만 공개하지 않음).
 * - headline: 판의 한 줄 소개(없으면 프로필의 한 줄 소개). competencies: [{label, preset}] 행 순서. skills_declared: 자기 선언 스킬.
 */
export const portfolioEditions = pgTable(
  'portfolio_editions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull(),
    headline: text('headline'),
    competencies: jsonb('competencies').$type<Array<Record<string, unknown>>>().notNull().default([]),
    skillsDeclared: text('skills_declared').array().notNull().default(sql`'{}'::text[]`),
    /** current: 공개 프로필에 쓰는 판 / superseded: 새 판으로 바뀜. */
    status: text('status').notNull().default('current'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('portfolio_editions_user_version_key').on(t.userId, t.version),
    uniqueIndex('portfolio_editions_current_key').on(t.userId).where(sql`${t.status} = 'current'`),
    check('portfolio_editions_status_check', sql`${t.status} in ('current', 'superseded')`),
    check('portfolio_editions_version_check', sql`${t.version} >= 1`),
    check('portfolio_editions_headline_check', sql`${t.headline} is null or char_length(${t.headline}) between 1 and 120`),
    check('portfolio_editions_competencies_array_check', sql`jsonb_typeof(${t.competencies}) = 'array'`),
  ],
)

/** 판의 대표 케이스 스터디(최대 5개, 순서). 공개 읽기는 그 케이스가 지금 게시 중이고 원본 release가 제공 가능할 때만 내용을 보여 줍니다. */
export const portfolioItems = pgTable(
  'portfolio_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => portfolioEditions.id),
    caseStudyId: uuid('case_study_id')
      .notNull()
      .references(() => caseStudies.id),
    position: integer('position').notNull(),
  },
  (t) => [
    unique('portfolio_items_edition_case_key').on(t.editionId, t.caseStudyId),
    unique('portfolio_items_edition_position_key').on(t.editionId, t.position),
    index('portfolio_items_case_study_id_idx').on(t.caseStudyId),
    check('portfolio_items_position_check', sql`${t.position} between 0 and 4`),
  ],
)

/**
 * 역량 × 근거: 판의 역량 행(competency_index) × 대표 케이스의 인용 하나(스냅샷 kind·key). 점수·수준 필드는 없습니다.
 * 칸은 읽을 때 이 행들을 종류별로 세어 만듭니다(@peerchive/domain computeCompetencyMatrix).
 */
export const competencyEvidence = pgTable(
  'competency_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => portfolioEditions.id),
    competencyIndex: integer('competency_index').notNull(),
    caseStudyId: uuid('case_study_id')
      .notNull()
      .references(() => caseStudies.id),
    releaseVersion: integer('release_version').notNull(),
    evidenceKind: text('evidence_kind').notNull(),
    evidenceKey: text('evidence_key').notNull(),
  },
  (t) => [
    unique('competency_evidence_ref_key').on(t.editionId, t.competencyIndex, t.caseStudyId, t.evidenceKind, t.evidenceKey),
    index('competency_evidence_case_study_id_idx').on(t.caseStudyId),
    check('competency_evidence_index_check', sql`${t.competencyIndex} between 0 and 11`),
    check('competency_evidence_kind_check', sql`${t.evidenceKind} in ('log', 'claim', 'milestone', 'artifact')`),
    check('competency_evidence_key_check', sql`char_length(${t.evidenceKey}) between 1 and 64`),
  ],
)

// ── 신고·운영 조치 (§6.6 Report·AuditEvent, §7.2 restricted, §8 운영 예외, T-15, ADR 0015) ─────────────

/**
 * 운영 조치. 신고를 처리(resolve·dismiss)할 때 하나씩 만들고, 처리한 신고들이 이 행을 가리킵니다(dismiss·조치 없음도 kind 'none'으로 남김).
 * - internal_note: 운영자 내부 메모(필수, 당사자·신고자에게 보이지 않음). public_reason: 당사자에게 보여 줄 사유(별도 필드).
 * - 대상 열은 신고 대상과 같은 모양(공개·release·항목 / 노트 / 케이스 / 프로필 사용자). 대상 내용은 복사하지 않습니다.
 * - 되돌림(reversed_*): 운영자의 제한 해제(lift) 또는 이의제기 되돌림(appeal). 행은 지우지 않습니다.
 * - 삭제 조치는 없습니다(차단 ≠ 삭제, §8). 비공개 과제 공간을 읽는 권한도 주지 않습니다.
 */
export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: moderationActionKind('kind').notNull(),
    /** resolved: 처리(조치 포함) / dismissed: 기각. */
    outcome: text('outcome').notNull(),
    targetType: reportTargetType('target_type').notNull(),
    targetKey: text('target_key').notNull(),
    publicationId: uuid('publication_id').references(() => publications.id),
    releaseId: uuid('release_id').references(() => publicationCandidates.id),
    itemKind: hiddenItemKind('item_kind'),
    itemKey: text('item_key'),
    seniorNoteId: uuid('senior_note_id').references(() => seniorNotes.id),
    caseStudyId: uuid('case_study_id').references(() => caseStudies.id),
    profileUserId: uuid('profile_user_id').references(() => users.id),
    /** 커뮤니티 공간 조치(restrict_space, C-02). */
    communitySpaceId: uuid('community_space_id').references((): AnyPgColumn => communitySpaces.id),
    internalNote: text('internal_note').notNull(),
    publicReason: text('public_reason'),
    notifyOwner: boolean('notify_owner').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => users.id),
    reverseNote: text('reverse_note'),
    /** lift(운영자 제한 해제) / appeal(이의제기 되돌림). */
    reverseCause: text('reverse_cause'),
  },
  (t) => [
    index('moderation_actions_target_key_idx').on(t.targetKey, t.createdAt),
    index('moderation_actions_publication_idx').on(t.publicationId),
    index('moderation_actions_senior_note_idx').on(t.seniorNoteId),
    index('moderation_actions_case_study_idx').on(t.caseStudyId),
    index('moderation_actions_profile_user_idx').on(t.profileUserId),
    index('moderation_actions_community_space_idx').on(t.communitySpaceId),
    check('moderation_actions_outcome_check', sql`${t.outcome} in ('resolved', 'dismissed') and (${t.outcome} = 'resolved' or ${t.kind} = 'none')`),
    check('moderation_actions_internal_note_check', sql`char_length(${t.internalNote}) between 1 and 1000`),
    check('moderation_actions_public_reason_check', sql`${t.publicReason} is null or char_length(${t.publicReason}) between 1 and 300`),
    check('moderation_actions_reverse_note_check', sql`${t.reverseNote} is null or char_length(${t.reverseNote}) between 1 and 1000`),
    check(
      'moderation_actions_reversed_check',
      sql`(${t.reversedAt} is null) = (${t.reverseCause} is null) and (${t.reverseCause} is null or ${t.reverseCause} in ('lift', 'appeal')) and (${t.reversedAt} is null or ${t.kind} <> 'none')`,
    ),
    // ::text 비교: 같은 migration에서 더한 enum 값을 리터럴로 쓰면 PostgreSQL이 "unsafe use of new value"로 거부합니다.
    check('moderation_actions_space_check', sql`${t.kind}::text <> 'restrict_space' or ${t.communitySpaceId} is not null`),
    check('moderation_actions_item_check', sql`(${t.kind} <> 'hide_item') or (${t.itemKind} is not null and ${t.itemKey} is not null and ${t.publicationId} is not null)`),
  ],
)

/**
 * 신고. 로그인한 사용자만(파일럿). 대상은 신고 때 지금 공개인 것이어야 하고, 대상 내용은 복사하지 않고 가리키기만 합니다
 * (공개 사례는 그때의 release, 노트·케이스는 그때의 version을 바꾸지 않는 포인터로 남김).
 * - target_key: 같은 대상을 묶는 키(@peerchive/domain reportTargetKey). 같은 신고자·대상의 처리 전 신고는 하나(부분 unique).
 * - details: 신고자가 쓴 설명(1000자, 선택). 운영자만 보고 감사 기록에는 넣지 않습니다.
 * - action_id: 처리한 운영 조치. 신고자에게는 상태(접수·검토 중·처리됨·기각)만 보여 줍니다.
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id),
    targetType: reportTargetType('target_type').notNull(),
    targetKey: text('target_key').notNull(),
    publicationId: uuid('publication_id').references(() => publications.id),
    /** 신고 때 제공 중이던 release(그 스냅샷이 운영자가 보는 "공개된 내용"). */
    releaseId: uuid('release_id').references(() => publicationCandidates.id),
    itemKind: hiddenItemKind('item_kind'),
    itemKey: text('item_key'),
    seniorNoteId: uuid('senior_note_id').references(() => seniorNotes.id),
    noteVersion: integer('note_version'),
    caseStudyId: uuid('case_study_id').references(() => caseStudies.id),
    caseStudyVersion: integer('case_study_version'),
    profileUserId: uuid('profile_user_id').references(() => users.id),
    /** 신고한 커뮤니티 공간(C-02). 내용은 복사하지 않습니다. */
    communitySpaceId: uuid('community_space_id').references((): AnyPgColumn => communitySpaces.id),
    reason: reportReason('reason').notNull(),
    details: text('details'),
    status: reportStatus('status').notNull().default('open'),
    assignedTo: uuid('assigned_to').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    actionId: uuid('action_id').references(() => moderationActions.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reports_open_reporter_target_key')
      .on(t.reporterId, t.targetKey)
      .where(sql`${t.status} in ('open', 'in_review')`),
    index('reports_target_key_idx').on(t.targetKey, t.status),
    index('reports_status_created_idx').on(t.status, t.createdAt),
    index('reports_reporter_idx').on(t.reporterId, t.createdAt),
    check('reports_details_check', sql`${t.details} is null or char_length(${t.details}) between 1 and 1000`),
    check('reports_closed_check', sql`(${t.status} in ('resolved', 'dismissed')) = (${t.closedAt} is not null and ${t.actionId} is not null)`),
    check('reports_item_key_check', sql`${t.itemKey} is null or char_length(${t.itemKey}) between 1 and 64`),
    check(
      'reports_target_check',
      sql`(${t.targetType} = 'publication' and ${t.publicationId} is not null and ${t.releaseId} is not null and ${t.itemKind} is null)
        or (${t.targetType} = 'publication_item' and ${t.publicationId} is not null and ${t.releaseId} is not null and ${t.itemKind} is not null and ${t.itemKey} is not null)
        or (${t.targetType} = 'senior_note' and ${t.seniorNoteId} is not null and ${t.noteVersion} is not null)
        or (${t.targetType} = 'case_study' and ${t.caseStudyId} is not null and ${t.caseStudyVersion} is not null)
        or (${t.targetType} = 'profile' and ${t.profileUserId} is not null)
        or (${t.targetType}::text = 'community_space' and ${t.communitySpaceId} is not null)`,
    ),
  ],
)

/**
 * 공개 사례 안의 가린 항목(hide_item). 공개(publication) 전체에 적용합니다: 스냅샷 키는 공개마다 안정되므로 새 버전을 게시해도 같은 항목은
 * 계속 가려집니다(되돌림·이의제기로만 풂). release_id는 가린 때의 release입니다. 공개 읽기(사례 페이지·파일·과목 허브·검색·신호·포크·
 * 케이스 스터디 인용)는 요청마다 이 표를 읽어 같은 요청 안에서 거릅니다.
 */
export const releaseHiddenItems = pgTable(
  'release_hidden_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publications.id),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => publicationCandidates.id),
    itemKind: hiddenItemKind('item_kind').notNull(),
    itemKey: text('item_key').notNull(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => moderationActions.id),
    createdAt: createdAt(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('release_hidden_items_active_key')
      .on(t.publicationId, t.itemKind, t.itemKey)
      .where(sql`${t.liftedAt} is null`),
    index('release_hidden_items_action_idx').on(t.actionId),
    check('release_hidden_items_key_check', sql`char_length(${t.itemKey}) between 1 and 64`),
  ],
)

/**
 * 보류(hold). 개인정보·저작권 신고가 들어오면 그 공개에 하나 생기고, 그 신고가 처리(resolve·dismiss)되면 풀립니다.
 * 열린 보류가 있으면 후보가 ready가 되지 않고 게시·새 버전 게시가 409 publish_blocked(hold_open)입니다(도메인 hasOpenHold).
 * 이미 제공 중인 release를 내리지는 않습니다(내리는 것은 운영 조치 restrict).
 */
export const holds = pgTable(
  'holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publications.id),
    reason: reportReason('reason').notNull(),
    createdByReportId: uuid('created_by_report_id')
      .notNull()
      .unique()
      .references(() => reports.id),
    createdAt: createdAt(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => users.id),
  },
  (t) => [
    index('holds_open_publication_idx').on(t.publicationId).where(sql`${t.releasedAt} is null`),
    check('holds_reason_check', sql`${t.reason} in ('personal_info', 'copyright')`),
  ],
)

/** 이의제기. 조치마다 하나(unique), 조치의 당사자만. 운영자가 유지(upheld) 또는 되돌림(reversed, 조치를 풂)으로 결정합니다. */
export const appeals = pgTable(
  'appeals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actionId: uuid('action_id')
      .notNull()
      .unique()
      .references(() => moderationActions.id),
    appellantId: uuid('appellant_id')
      .notNull()
      .references(() => users.id),
    message: text('message').notNull(),
    status: appealStatus('status').notNull().default('open'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('appeals_status_created_idx').on(t.status, t.createdAt),
    check('appeals_message_check', sql`char_length(${t.message}) between 1 and 1000`),
    check('appeals_decision_note_check', sql`${t.decisionNote} is null or char_length(${t.decisionNote}) between 1 and 1000`),
    check('appeals_decided_check', sql`(${t.status} = 'open') = (${t.decidedAt} is null)`),
  ],
)

// ── 운영: 삭제 장부·분석 이벤트·worker 상태 (§6.6 DeletionLedger, §11, §14, DELIVERY_PLAN §6, T-16, ADR 0016) ─────────────

/**
 * 삭제 장부(DeletionLedger). 탈퇴 계정 정리(purge) 한 번에 지운 대상 종류마다 한 행(지운 개수)을 남깁니다.
 * **개인정보 없음**: 사용자 id 대신 서버 비밀 pepper로 만든 HMAC-SHA256(subject_hash)만 두고, 이름·이메일·제목·id 목록을 넣지 않습니다.
 * 오래된 백업을 복구하면 `pnpm ops:reapply-deletions`가 이 장부(지금 DB 또는 내보낸 파일)의 subject_hash와 복구된 사용자 id의 HMAC을
 * 맞춰 다시 정리합니다(§11 "복구 시 최신 삭제를 재적용하기 전에는 외부 트래픽을 열지 않음"). pepper를 바꾸면 재적용이 맞추지 못하므로 바꾸지 않습니다.
 */
export const deletionLedger = pgTable(
  'deletion_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectHash: text('subject_hash').notNull(),
    /** 지운 대상 종류(예: profile, sessions, solo_projects, artifact_objects). */
    entityKind: text('entity_kind').notNull(),
    count: integer('count').notNull(),
    /** 탈퇴 요청 시각(분 단위로 자름). */
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }).notNull().defaultNow(),
    /** purge: 유예 기간 뒤 정리 / reapply: 복구 뒤 재적용. */
    source: text('source').notNull().default('purge'),
  },
  (t) => [
    index('deletion_ledger_subject_hash_idx').on(t.subjectHash),
    check('deletion_ledger_subject_hash_check', sql`${t.subjectHash} ~ '^[0-9a-f]{64}$'`),
    check('deletion_ledger_entity_kind_check', sql`${t.entityKind} ~ '^[a-z_]{1,40}$'`),
    check('deletion_ledger_count_check', sql`${t.count} >= 0`),
    check('deletion_ledger_source_check', sql`${t.source} in ('purge', 'reapply')`),
  ],
)

/**
 * pilot 분석 이벤트(DELIVERY_PLAN §6). 과제 본문·파일 내용·검색 원문·연락처·제목·URL·파일 이름은 넣지 않습니다.
 * - actor_hash / project_hash: 사용자·프로젝트 id의 HMAC-SHA256(분석 전용 pepper, 삭제 장부 pepper와 다름). hash_key_id는 pepper를
 *   구분하는 짧은 값(pepper의 SHA-256 앞 8자)이며, pepper를 바꾸면(rotate) 이전 이벤트와 이어지지 않습니다.
 * - props: 이벤트마다 허용 목록(@peerchive/domain ANALYTICS_PROP_SPECS)의 키·값(태그·출처·개수·수준·참거짓)만. 목록 밖이면 이벤트를 버립니다.
 * - 수집 거부(users.analytics_opt_out)한 사람은 이벤트를 만들지 않습니다. 탈퇴 정리 때 그 사람의 이벤트도 지웁니다.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: analyticsEventName('name').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorHash: text('actor_hash').notNull(),
    projectHash: text('project_hash'),
    hashKeyId: text('hash_key_id').notNull(),
    props: jsonb('props').$type<Record<string, string | number | boolean>>().notNull().default({}),
  },
  (t) => [
    index('analytics_events_name_occurred_idx').on(t.name, t.occurredAt),
    index('analytics_events_actor_occurred_idx').on(t.actorHash, t.occurredAt),
    check('analytics_events_actor_hash_check', sql`${t.actorHash} ~ '^[0-9a-f]{64}$'`),
    check('analytics_events_project_hash_check', sql`${t.projectHash} is null or ${t.projectHash} ~ '^[0-9a-f]{64}$'`),
    check('analytics_events_hash_key_id_check', sql`${t.hashKeyId} ~ '^[0-9a-f]{8}$'`),
    check('analytics_events_props_object_check', sql`jsonb_typeof(${t.props}) = 'object'`),
  ],
)

/**
 * worker 상태 기록(§14 관측). worker 프로세스는 1분마다 name='worker' 행을, 주기 작업은 실행할 때마다 name='task:<이름>' 행을 고쳐 씁니다.
 * details에는 개수·상태 코드만 둡니다(내용·id 목록 없음). 운영자 health 상세 확인이 마지막 시각으로 worker 정지를 알아챕니다.
 */
export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    name: text('name').primaryKey(),
    beatAt: timestamp('beat_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    details: jsonb('details').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  },
  (t) => [
    check('worker_heartbeats_name_check', sql`${t.name} ~ '^[a-z0-9:_.-]{1,60}$'`),
    check('worker_heartbeats_details_object_check', sql`jsonb_typeof(${t.details}) = 'object'`),
  ],
)

// ── 학교 메일 인증 (C-01, PROOFU_EVOLUTION_PLAN §8.6, SYSTEM_DESIGN §6.7 SchoolAffiliation·§6.7.2 이관 원칙, ADR 0018) ─────────────

/**
 * 학교 메일 도메인. 운영자만 등록·삭제합니다(API·CLI, 감사 기록). 메일 도메인이 이 값과 같거나 그 하위 도메인이면(`yu.ac.kr` → `stu.yu.ac.kr`)
 * 그 학교 메일로 봅니다. domain은 소문자 ASCII(IDN은 punycode)이며 전체에서 하나입니다(한 도메인은 한 학교). 학교 병합 때 정본으로 옮깁니다.
 */
export const schoolEmailDomains = pgTable(
  'school_email_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    domain: text('domain').notNull(),
    /** 등록한 운영자. CLI로 등록하면 null(운영 콘솔). */
    addedBy: uuid('added_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('school_email_domains_domain_key').on(t.domain),
    index('school_email_domains_school_id_idx').on(t.schoolId),
    check('school_email_domains_domain_check', sql`${t.domain} ~ '^[a-z0-9]([a-z0-9.-]{1,251})[a-z0-9]$' and ${t.domain} like '%.%'`),
  ],
)

/**
 * 기관 소속 인증(SYSTEM_DESIGN의 SchoolAffiliation = InstitutionAffiliation의 대학·메일 사례). 이관 원칙대로 처음부터 institution_* 이름과
 * kind·method 열을 두되, 기관 테이블은 아직 없으므로 기존 schools를 가리킵니다(P2에서 schools를 기관으로 일반화, ADR 0018).
 *
 * - **메일 주소를 저장하지 않습니다.** HMAC-SHA256(PEERCHIVE_AFFILIATION_PEPPER, 정규화한 주소)과 도메인만 둡니다. 인증 코드는 요청 즉시 보내고
 *   주소는 메모리에서만 씁니다. 해제·취소·만료되면 email_hash도 지웁니다(학교·도메인·인증 시각 이력만 남음).
 * - 같은 학교 메일 주소는 active 행 하나에서만 인증됩니다(email_hash 부분 unique). 한 사용자·학교마다 진행 중(pending/active) 행은 하나입니다.
 * - 졸업 뒤 메일이 없어져도 active를 유지합니다(주기적 재인증 없음). standing은 자기 선언(student → alumni만).
 * - department_label은 자기 신고 학과(선택, 40자)이며 공개 DTO·운영자 목록에 싣지 않습니다. 학번은 받지 않습니다.
 * - 과목 허브 작성 자격(canWriteToCourseHub)은 이 표의 active 행으로 판정합니다.
 */
export const institutionAffiliations = pgTable(
  'institution_affiliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    institutionKind: institutionKind('institution_kind').notNull().default('university'),
    /** 정본 학교. 학교 병합 때 정본으로 옮깁니다. */
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    method: affiliationMethod('method').notNull().default('email'),
    /** 정규화한 학교 메일 주소의 HMAC(hex 64). pending·active일 때만 있고 해제·취소·만료되면 null. */
    emailHash: text('email_hash'),
    /** 메일 도메인(소문자 ASCII). 본인·운영자에게만 보입니다. */
    emailDomain: text('email_domain').notNull(),
    standing: affiliationStanding('standing').notNull(),
    /** 자기 신고 학과(선택, 정규화, 40자). 공개하지 않습니다. */
    departmentLabel: text('department_label'),
    status: affiliationStatus('status').notNull().default('pending'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** user_removed(본인 해제) / operator(운영자 취소, 사유는 감사 기록) / merged_duplicate(학교 병합으로 겹침). */
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('institution_affiliations_email_hash_active_key').on(t.emailHash).where(sql`${t.status} = 'active'`),
    uniqueIndex('institution_affiliations_user_school_open_key').on(t.userId, t.schoolId).where(sql`${t.status} in ('pending', 'active')`),
    index('institution_affiliations_user_id_idx').on(t.userId),
    index('institution_affiliations_school_id_idx').on(t.schoolId),
    check('institution_affiliations_email_hash_check', sql`${t.emailHash} is null or ${t.emailHash} ~ '^[0-9a-f]{64}$'`),
    check('institution_affiliations_open_hash_check', sql`${t.status} not in ('pending', 'active') or ${t.emailHash} is not null`),
    check('institution_affiliations_active_verified_check', sql`${t.status} <> 'active' or ${t.verifiedAt} is not null`),
    check('institution_affiliations_revoked_check', sql`${t.status} <> 'revoked' or (${t.revokedAt} is not null and ${t.revokedReason} is not null)`),
    check(
      'institution_affiliations_department_label_check',
      sql`${t.departmentLabel} is null or char_length(${t.departmentLabel}) between 1 and 40`,
    ),
    check('institution_affiliations_email_domain_check', sql`char_length(${t.emailDomain}) between 3 and 253`),
    check('institution_affiliations_revoked_reason_check', sql`${t.revokedReason} is null or ${t.revokedReason} in ('user_removed', 'operator', 'merged_duplicate')`),
  ],
)

/**
 * 학교 메일 인증 코드(6자리). 원문 대신 HMAC(pepper, 소속 id + 코드)만 저장하고, 10분 뒤 만료, 틀린 시도 5회면 잠깁니다(소속 행 expired).
 * 한 번 쓰면 used_at. worker 주기 작업이 오래된 행을 지웁니다.
 */
export const affiliationCodes = pgTable(
  'affiliation_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    affiliationId: uuid('affiliation_id')
      .notNull()
      .references(() => institutionAffiliations.id),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('affiliation_codes_affiliation_id_idx').on(t.affiliationId),
    check('affiliation_codes_code_hash_check', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check('affiliation_codes_attempts_check', sql`${t.attempts} between 0 and 5`),
  ],
)

// ── 캠퍼스 커뮤니티: 공간·멤버십·게시판 (C-02, PROOFU_EVOLUTION_PLAN §8.9.2–§8.9.4, SYSTEM_DESIGN §6.7, ADR 0019) ─────────────
//
// 이 테이블들은 web `server/modules/community`만 읽고 씁니다. 공개 조회 경로(`/api/v1/public/**`, 검색 색인 search_documents, 과목 집계,
// 공개 release)는 이 테이블을 읽지 않습니다(SYSTEM_DESIGN §8.2·§11). 예외는 운영(신고 처리·탈퇴 정리)뿐입니다.

/**
 * 커뮤니티 공간(공식 학교·학과 페이지, 사용자 방, 스터디 방).
 * - official_*: 운영자만 만듭니다. school_id 필수, 이름 표시는 anonymous 고정, 가입 방식·정원은 쓰지 않습니다(자격은 학교 인증에서 나옴).
 *   학교마다 공식 학교 페이지 하나, (학교, 학과 키)마다 공식 학과 페이지 하나(부분 unique). 학과는 C-01의 자기 신고 학과와 같은
 *   labelKey(department_key)로 맞춥니다(학과 테이블 없음, ADR 0019).
 * - user_room: active 학교 인증이 있는 사용자가 만듭니다. school_id는 학교를 연결했을 때만(그 학교 인증 계정만 들어옴).
 *   정원 기본·최대 300, 더 큰 요청은 capacity_requested로 남겨 운영자가 검토합니다.
 * - study_room: 모집 마감(C-07)이 만듭니다. 지금은 내부 서비스만 있습니다.
 * - school_id는 만들 때의 정본 학교이며, 학교 병합 뒤에도 읽기는 coalesce(merged_into, id)로 정본을 따라갑니다.
 * - slug: 무작위 소문자·숫자 10자(unlisted 방의 링크 역할). 이름은 주소에 넣지 않습니다.
 */
export const communitySpaces = pgTable(
  'community_spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: communitySpaceKind('kind').notNull(),
    schoolId: uuid('school_id').references(() => schools.id),
    /** 공식 학과 페이지의 학과 이름(운영자가 정한 표시용). */
    departmentLabel: text('department_label'),
    /** 학과 키(@peerchive/domain departmentKey = labelKey). 자기 신고 학과와 이 키가 같으면 그 학과로 봅니다. */
    departmentKey: text('department_key'),
    /** 과목과 연결한 방(§8.9.2 "이 과목 이야기하기", 엠바고 적용). 연결 화면은 아직 없음. */
    linkedCourseId: uuid('linked_course_id').references(() => courses.id),
    name: text('name').notNull(),
    description: text('description'),
    slug: text('slug').notNull(),
    currentNameMode: communityNameMode('current_name_mode').notNull(),
    discovery: spaceDiscovery('discovery').notNull().default('listed'),
    joinPolicy: spaceJoinPolicy('join_policy').notNull().default('open'),
    capacity: integer('capacity').notNull().default(300),
    /** 300을 넘는 정원 요청(운영자 검토 대기). 운영자가 정하면 null. */
    capacityRequested: integer('capacity_requested'),
    status: spaceStatus('status').notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    restrictedAt: timestamp('restricted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('community_spaces_slug_key').on(t.slug),
    uniqueIndex('community_spaces_official_school_key').on(t.schoolId).where(sql`${t.kind} = 'official_school'`),
    uniqueIndex('community_spaces_official_department_key').on(t.schoolId, t.departmentKey).where(sql`${t.kind} = 'official_department'`),
    index('community_spaces_school_id_idx').on(t.schoolId),
    index('community_spaces_status_discovery_idx').on(t.status, t.discovery),
    check('community_spaces_slug_check', sql`${t.slug} ~ '^[a-z0-9]{10}$'`),
    check('community_spaces_name_check', sql`char_length(${t.name}) between 1 and 60`),
    check('community_spaces_description_check', sql`${t.description} is null or char_length(${t.description}) between 1 and 300`),
    check('community_spaces_capacity_check', sql`${t.capacity} between 2 and 100000`),
    check('community_spaces_capacity_requested_check', sql`${t.capacityRequested} is null or ${t.capacityRequested} between 2 and 100000`),
    check(
      'community_spaces_official_check',
      sql`${t.kind} not in ('official_school', 'official_department') or (${t.schoolId} is not null and ${t.currentNameMode} = 'anonymous')`,
    ),
    check(
      'community_spaces_department_check',
      sql`(${t.kind} = 'official_department') = (${t.departmentKey} is not null) and (${t.departmentKey} is null) = (${t.departmentLabel} is null)`,
    ),
    check('community_spaces_department_label_check', sql`${t.departmentLabel} is null or char_length(${t.departmentLabel}) between 1 and 40`),
    check('community_spaces_archived_check', sql`${t.status} <> 'archived' or ${t.archivedAt} is not null`),
    check('community_spaces_restricted_check', sql`${t.status} <> 'restricted' or ${t.restrictedAt} is not null`),
  ],
)

/**
 * 공간 멤버십. (space, user) 하나. 공간마다 active owner는 하나(부분 unique, 사용자 방·스터디 방만).
 * 공식 페이지에서는 모더레이터 지정(role moderator)과 학과 쓰기 제한(status removed)에만 씁니다(읽기·쓰기 자격은 학교 인증).
 * joined_at: active가 된 시각(승계 순서). requested_at: 승인 요청 시각.
 */
export const spaceMemberships = pgTable(
  'space_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: spaceRole('role').notNull().default('member'),
    status: spaceMembershipStatus('status').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('space_memberships_space_user_key').on(t.spaceId, t.userId),
    uniqueIndex('space_memberships_active_owner_key').on(t.spaceId).where(sql`${t.role} = 'owner' and ${t.status} = 'active'`),
    index('space_memberships_user_id_idx').on(t.userId, t.status),
    index('space_memberships_space_status_idx').on(t.spaceId, t.status),
    check('space_memberships_active_joined_check', sql`${t.status} <> 'active' or ${t.joinedAt} is not null`),
  ],
)

/** 게시판. 공식 페이지는 기본 세트, 사용자 방은 general 하나에서 시작(최대 10개). notice는 항상 write_role moderator. */
export const boards = pgTable(
  'boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    kind: boardKind('kind').notNull(),
    title: text('title').notNull(),
    writeRole: boardWriteRole('write_role').notNull().default('member'),
    position: integer('position').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('boards_space_title_key').on(t.spaceId, t.title),
    index('boards_space_position_idx').on(t.spaceId, t.position),
    check('boards_title_check', sql`char_length(${t.title}) between 1 and 30`),
    check('boards_notice_write_role_check', sql`${t.kind} <> 'notice' or ${t.writeRole} = 'moderator'`),
  ],
)

/**
 * 공간 초대 링크. 원문 토큰은 만든 응답에서 한 번만 돌려주고 SHA-256 해시만 저장합니다. 7일, 한 번만, 취소 가능(과제 초대와 같은 규칙).
 */
export const spaceInvitations = pgTable(
  'space_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('space_invitations_token_hash_key').on(t.tokenHash),
    index('space_invitations_space_id_idx').on(t.spaceId),
    check('space_invitations_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('space_invitations_used_check', sql`(${t.usedAt} is null) = (${t.usedBy} is null)`),
  ],
)

/**
 * 공식 페이지 개설 요청(§6.7 SpaceOpeningRequest). 학교 인증 계정이 (학교, 학과 키)마다 한 번(department_key ''는 학교 페이지).
 * 서로 다른 요청자 수가 기준(10)에 이르거나 운영자가 학생회 요청으로 표시하면 운영자에게 알립니다(감사 기록 + 운영자 목록). 자동 개설하지 않습니다.
 * 요청 수는 운영자에게만 보입니다.
 */
export const officialPageRequests = pgTable(
  'official_page_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    departmentLabel: text('department_label'),
    departmentKey: text('department_key').notNull().default(''),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id),
    source: officialRequestSource('source').notNull().default('student'),
    /** 학생회 요청으로 표시한 운영자. */
    sourceMarkedBy: uuid('source_marked_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('official_page_requests_target_requester_key').on(t.schoolId, t.departmentKey, t.requesterId),
    index('official_page_requests_target_idx').on(t.schoolId, t.departmentKey),
    index('official_page_requests_requester_idx').on(t.requesterId),
    check('official_page_requests_department_check', sql`(${t.departmentKey} = '') = (${t.departmentLabel} is null)`),
    check('official_page_requests_department_label_check', sql`${t.departmentLabel} is null or char_length(${t.departmentLabel}) between 1 and 40`),
  ],
)
