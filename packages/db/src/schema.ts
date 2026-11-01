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
 * C-03(0018 migration): 이름 표시 방식 변경 이력(name_mode_changes: 7일 예약·적용·취소, 공간마다 예약 하나), 커뮤니티 알림
 * (community_notices: 받는 사람·공간·종류·허용 목록 payload·읽음), 선택 실명(users.real_name, real 방식 글에만), 분석 이벤트
 * name_mode_scheduled·name_mode_applied. 결정은 ADR 0020.
 * C-04(0020 migration): 글·댓글·스레드 익명 번호·공감. 결정은 ADR 0022.
 * C-06(0021 migration): 이용 제한(community_sanctions)·운영자 작성자 확인 기록(community_author_lookups)·방 운영진의 제재 요청
 * (community_sanction_requests), 조치 종류 space_hide·sanction, 알림 item_auto_hidden·item_restored, 분석 이벤트 3개. 결정은 ADR 0023.
 * S-01(0026 migration): 페르소나(personas: 계정당 real·display 하나씩, handle 전역 유일)·표시명 ↔ 실명 연결 플래그(identity_links, 기본 숨김),
 * 프로필·포트폴리오 판의 페르소나 귀속(profiles.persona_id 기본 키·portfolio_editions.persona_id). 결정은 ADR 0028.
 * S-02(0027 migration): 페르소나 활동(persona_activities, persona_id NOT NULL, 투영 검사 트리거), 커뮤니티 글·댓글의 작성 시점 페르소나
 * (community_posts·community_comments.persona_id, 익명이면 항상 null), social DB 역할(peerchive_social, 커뮤니티 테이블 권한 없음). 결정은 ADR 0029.
 * S-06(0030 migration): 소셜 링크(social_links: 페르소나별, 사용자당 같은 주소 하나, 되돌림 링크 확인 상태·연속 실패 수). 결정은 ADR 0034.
 * I-01(0033 migration): 기관 일반화(schools.kind, institution_kind·affiliation_method 값 추가), 기수(institution_cohorts), 초대 코드
 * (institution_invite_codes, HMAC만), 기수 승인(cohort_approvals), 수료증 확인(certificate_checks, 결정 뒤 파일 삭제), 소속의 cohort_id·
 * 메일 아닌 수단(email_domain null 허용), 삭제 장부 source `retention`. 결정은 ADR 0037.
 * A-01(0034 migration): 사용자 방 템플릿(community_spaces.template)·방별 프로필(room_profiles)·기수 이력. 결정은 ADR 0038.
 * A-02(0035 migration): 동문회·OB 방의 일정(room_events)·회차별 참석 응답(room_event_rsvps)·공지 읽음 표시(notice_reads)·
 * 투표(room_polls·room_poll_votes)·앨범 사진(room_album_photos, 격리 키 + 검사·메타데이터 제거). 결정은 ADR 0039.
 * A-03(0036 migration): 동문회·OB 방의 멤버 명부 동의(directory_entries, 동의한 멤버만 행·철회·나가기 시 즉시 삭제). 결정은 ADR 0040.
 * I-02(0041 migration): 기관 운영진(institution_staff: 운영자가 지정·해제, 기관당 사람마다 열린 행 하나)과 기수 방(community_spaces.cohort_id,
 * 사용자 방만, 기수마다 보관되지 않은 방 하나). 결정은 ADR 0044.
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
/** 페르소나 종류(S-01, @peerchive/domain PERSONA_KINDS): 실명(3단계) / 표시명(2단계). 0~1단계(익명)는 페르소나를 만들지 않습니다(§6.7.1). */
export const personaKind = pgEnum('persona_kind', ['real', 'display'])
/** 계정 공개 여부(S-01에서는 저장만, 비공개 계정 흐름은 S-04). */
export const personaAccountPrivacy = pgEnum('persona_account_privacy', ['public', 'private'])
/** 페르소나 상태. deactivated는 공개 경로에서 없는 handle처럼 404입니다(S-01에는 바꾸는 API가 없음, ADR 0028). */
export const personaStatus = pgEnum('persona_status', ['active', 'deactivated'])
/**
 * 페르소나 활동의 원천(S-02, SYSTEM_DESIGN §6.7.1 PersonaActivity, @peerchive/domain PERSONA_ACTIVITY_SOURCES).
 * 커뮤니티 댓글·막힘 Q&A·스터디 기록 안의 로그는 원천이 아닙니다(투영 경로 자체가 없음).
 */
export const personaActivitySource = pgEnum('persona_activity_source', ['publication_release', 'senior_note', 'study_release', 'profile_post', 'community_post'])
/** 공개 범위 항목(S-03, @peerchive/domain VISIBILITY_ITEM_KINDS). 공개 사례·케이스 스터디는 항목이 아닙니다(공개 절차로만, §8.3 불변조건 2). */
export const visibilityItemKind = pgEnum('visibility_item_kind', ['project_list', 'posts', 'notes_and_studies', 'follow_lists'])
/** 공개 범위 단계(S-03, @peerchive/domain VISIBILITY_AUDIENCES). public ⊃ signed_in ⊃ same_institution ⊃ approved_followers ⊃ private. */
export const visibilityAudience = pgEnum('visibility_audience', ['public', 'signed_in', 'same_institution', 'approved_followers', 'private'])
/** 팔로우 상태(S-04, @peerchive/domain FOLLOW_STATUSES): 비공개 계정은 pending → active(승인), 공개 계정은 바로 active. */
export const followStatus = pgEnum('follow_status', ['pending', 'active'])
/** 차단의 숨김 범위(S-04, SYSTEM_DESIGN §6.7.1 Block): 차단을 건 페르소나만(기본) / 내 모든 페르소나(사용자가 고를 때만). */
export const blockScope = pgEnum('block_scope', ['origin_persona', 'all_personas'])
/** 소셜 링크 서비스(S-06, @peerchive/domain SOCIAL_LINK_PROVIDERS). github·instagram·youtube·linkedin은 그 서비스의 주소만 받습니다. */
export const socialLinkProvider = pgEnum('social_link_provider', ['github', 'blog', 'linkedin', 'instagram', 'youtube', 'other'])
/** 되돌림 링크 확인 상태(S-06, @peerchive/domain SOCIAL_LINK_VERIFICATIONS). verified는 계정에 프로필 링크가 있음을 확인했다는 뜻일 뿐입니다. */
export const socialLinkVerification = pgEnum('social_link_verification', ['unverified', 'verified', 'lost'])
/** 프로필 글 상태(S-05, @peerchive/domain PROFILE_POST_STATUSES): 게시 중 / 작성자가 지움(soft) / 운영 조치로 숨김(S-07 신고 처리). */
export const profilePostStatus = pgEnum('profile_post_status', ['published', 'deleted', 'hidden'])
/** 마지막 확인 결과(S-06, @peerchive/domain SOCIAL_LINK_CHECK_RESULTS, 본인 화면에만). */
export const socialLinkCheckResult = pgEnum('social_link_check_result', ['found', 'missing', 'fetch_failed', 'blocked'])
export const contactPolicy = pgEnum('contact_policy', ['closed', 'on_request', 'open'])
export const semester = pgEnum('semester', ['spring', 'summer', 'fall', 'winter'])
/** 과제 종류. study는 스터디 방의 기록(C-08, ADR 0026): 스터디 방이 기록을 켜면 만들어지는 내부 과제 공간이고 멤버십은 방에서 파생됩니다. */
export const projectKind = pgEnum('project_kind', ['individual', 'team', 'study'])
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
/** 로그 피드백 댓글 상태(E-10, ADR 0054): 게시 / 작성자가 지움(탈퇴 정리 포함, 본문을 비움) / owner가 숨김. */
export const logCommentStatus = pgEnum('log_comment_status', ['published', 'deleted', 'hidden'])
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
/**
 * 선배 노트 작성자 표시(@peerchive/domain SENIOR_NOTE_DISPLAY_MODES): 계정 이름 / 직접 입력한 표시명 / 익명("익명 선배").
 * affiliation(A-06, ADR 0043): 토픽(소속 표시 익명) 답변을 옮기며 "소속 표시 유지"를 고른 노트. 원 글에 고정된 소속 표시 문자열(affiliation_label)만 보이고
 * 페르소나로 투영되지 않습니다. 옮기기로만 만들 수 있습니다. 같은 migration의 check는 `display_mode::text`로 비교합니다.
 */
export const seniorNoteDisplayMode = pgEnum('senior_note_display_mode', ['name', 'display', 'anonymous', 'affiliation'])
/** 선배 노트 상태. hidden은 운영자 조치용(T-15, 지금은 API 없음). 공개 조회는 published만 봅니다. */
export const seniorNoteStatus = pgEnum('senior_note_status', ['draft', 'published', 'withdrawn', 'hidden'])
/** 선배 노트의 대략 총 소요 시간(supply-kit §2): ~10h / ~20h / ~40h / 40h+. */
export const seniorNoteTimeBucket = pgEnum('senior_note_time_bucket', ['lt10h', 'lt20h', 'lt40h', 'forty_plus'])
/** 유용성 신호의 대상: 공개 사례의 막힘 카드(공개·로그 키) / 게시된 선배 노트. */
export const signalTargetKind = pgEnum('signal_target_kind', ['stuck_item', 'senior_note', 'course_qa'])
/** 유용성 신호 종류: 나도 여기서 막혔어요 / 도움됐어요. */
export const signalKind = pgEnum('signal_kind', ['me_too', 'helped'])
/** 검색 문서 종류(파생 데이터): 공개 사례 / 막힘 카드 / 선배 노트. */
export const searchDocKind = pgEnum('search_doc_kind', ['case', 'stuck', 'note', 'qa'])
/** 막힘 Q&A(C-09, ADR 0025) 상태. */
export const courseQaStatus = pgEnum('course_qa_status', ['published', 'withdrawn', 'hidden'])
/** 케이스 스터디 지원 직무(T-14). */
export const caseJobTarget = pgEnum('case_job_target', ['backend', 'frontend', 'data', 'pm', 'design', 'general'])
/** 케이스 스터디 상태(T-14): 초안 → 게시 → (원본 release 철회·대체 시) 이용 불가. 이용 불가는 되돌리지 않습니다. */
export const caseStudyStatus = pgEnum('case_study_status', ['draft', 'published', 'unavailable'])
/** 신고 대상(T-15, @peerchive/domain REPORT_TARGET_TYPES). 지금 공개인 것만 신고할 수 있습니다(community_space는 신고자가 읽을 수 있는 공간, C-02). */
export const reportTargetType = pgEnum('report_target_type', [
  'publication',
  'publication_item',
  'senior_note',
  'case_study',
  'profile',
  'community_space',
  'community_post',
  'community_comment',
  'community_recruitment',
  'community_application',
  'course_qa',
  // S-07(ADR 0036): 페르소나 단위 공개 프로필·프로필 글·소셜 링크.
  'persona',
  'profile_post',
  'social_link',
  // A-06(ADR 0043): 수료 회고(읽을 수 있는 사람이 신고).
  'completion_retro',
  // A-07(ADR 0045): 동문회·OB 방 항목(명부 항목·일정·투표·앨범 사진·방별 프로필) — 종류는 room_item_kind.
  'room_item',
  // E-04(ADR 0049): 막힘 Q&A 스레드의 글 하나(질문·답변).
  'stuck_qa_post',
])
/** A-07(ADR 0045, @peerchive/domain ROOM_ITEM_KINDS): 신고·숨길 수 있는 동문회·OB 방 항목 종류. */
export const roomItemKind = pgEnum('room_item_kind', ['directory_entry', 'event', 'poll', 'album_photo', 'room_profile'])
/**
 * 신고 사유(T-15, REPORT_REASONS). 개인정보·저작권은 공개 사례에 보류를 겁니다. impersonation(표시명 사칭, S-07)은 프로필 신고에만.
 * affiliation_impersonation(소속·기수 사칭, A-07)은 커뮤니티 글·댓글·수료 회고·방 항목에만.
 */
export const reportReason = pgEnum('report_reason', [
  'personal_info',
  'answer_sharing',
  'copyright',
  'harassment',
  'false_claim',
  'spam',
  'other',
  'impersonation',
  'affiliation_impersonation',
])
/** 신고 상태(T-15): 접수 → 검토 중 → 처리됨/기각. 닫힌 신고는 다시 열지 않습니다. */
export const reportStatus = pgEnum('report_status', ['open', 'in_review', 'resolved', 'dismissed'])
/** 운영 조치 종류(T-15, MODERATION_ACTION_KINDS). 모두 공개 차단이며 삭제는 없습니다. */
export const moderationActionKind = pgEnum('moderation_action_kind', [
  'none',
  'restrict',
  'hide_item',
  'hide_note',
  'hide_case_study',
  'hide_profile',
  'restrict_space',
  'archive_space',
  'hide_post',
  'hide_comment',
  'space_hide',
  'sanction',
  'hide_recruitment',
  'hide_application',
  'hide_qa',
  // S-07(ADR 0036): 페르소나 하나의 공개 프로필·프로필 글·소셜 링크 숨기기.
  'hide_persona',
  'hide_profile_post',
  'hide_social_link',
  // A-06(ADR 0043): 수료 회고 숨기기(published → hidden, 되돌리면 다시 published).
  'hide_retro',
  // A-07(ADR 0045): 방 항목 하나의 hidden_at.
  'hide_room_item',
  // E-04(ADR 0049): 막힘 Q&A 글 하나 published → hidden(질문이면 스레드가 안 보임).
  'hide_stuck_qa_post',
])
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
  'name_mode_scheduled',
  'name_mode_applied',
  'post_created',
  'comment_created',
  'reaction_added',
  'community_report_filed',
  'community_auto_hidden',
  'community_sanction_issued',
  'recruitment_created',
  'application_submitted',
  'recruitment_closed',
  'archive_transfer_requested',
  'archive_transfer_completed',
  'course_qa_published',
  'study_record_enabled',
  'community_author_lookup',
  // S-07(DELIVERY_PLAN §6.2 P1, ADR 0036): 사용자 키만, 페르소나 id·상대방 키 없음.
  'persona_created',
  'identity_link_toggled',
  'visibility_changed',
  'project_listed',
  'follow_requested',
  'follow_approved',
  'follower_removed',
  'block_created',
  'mute_created',
  'feed_item_opened',
  'social_link_verified',
  // A-07(DELIVERY_PLAN §6.2 P2, ADR 0045): 사용자 키만(익명 내용은 키 없음), 시 단위 시각.
  'alumni_room_created',
  'event_created',
  'rsvp_submitted',
  'directory_consent_changed',
  'topic_post_created',
  'completion_retro_published',
])
/** 기관 종류(C-01은 university만, I-01에서 나머지, SYSTEM_DESIGN §6.7.2, ADR 0018·0037). */
export const institutionKind = pgEnum('institution_kind', ['university', 'bootcamp', 'training_program', 'club_federation'])
/** 소속 인증 수단(C-01은 email만, I-01에서 초대 코드·기수 승인·수료증 확인, ADR 0037). 새 수단은 대학이 아닌 기관에서만 씁니다. */
export const affiliationMethod = pgEnum('affiliation_method', ['email', 'invite_code', 'cohort_approval', 'certificate_check'])
/** 재학생/졸업생(자기 선언). 재학생 → 졸업생으로만 바꿀 수 있습니다. */
export const affiliationStanding = pgEnum('affiliation_standing', ['student', 'alumni'])
/** pending(코드 대기) → active(인증) / expired(만료·시도 초과·새 요청으로 대체) / revoked(본인 해제·운영자 취소). */
export const affiliationStatus = pgEnum('affiliation_status', ['pending', 'active', 'revoked', 'expired'])
/**
 * 커뮤니티 공간 종류(C-02, @peerchive/domain SPACE_KINDS). official_*는 운영자만 만듭니다.
 * topic(A-05, ADR 0042): 학교를 넘나드는 토픽. 운영자만 만들고 기관 인증이 하나라도 있으면 읽고 씁니다(멤버십 없음).
 * enum 값은 0038에서 더했으므로 같은 migration의 check는 `kind::text`로 비교합니다(ALTER TYPE … ADD VALUE는 같은 트랜잭션에서 쓸 수 없음).
 */
export const communitySpaceKind = pgEnum('community_space_kind', ['official_school', 'official_department', 'user_room', 'study_room', 'topic'])
/**
 * 이름 표시 방식(실명·표시명·익명). 공식 페이지는 anonymous 고정. 바꾸기는 C-03(7일 예약).
 * affiliated_anonymous(A-05, 1단계 소속 표시 익명, ADR 0042): 토픽 공간·글·댓글에만. 이름은 익명이고 작성 시점에 고정한 소속 표시만 붙습니다.
 * persona_id는 항상 null(check)이고 페르소나 활동으로 투영되지 않습니다. 같은 migration의 check는 `name_mode::text`로 비교합니다.
 */
export const communityNameMode = pgEnum('community_name_mode', ['real', 'display', 'anonymous', 'affiliated_anonymous'])
/** 토픽 분류(A-05, SYSTEM_DESIGN §6.7.2 topic_category, @peerchive/domain TOPIC_CATEGORIES): 취준·대학원·창업·군대/예비역·학교생활·직무. */
export const topicCategory = pgEnum('topic_category', ['career', 'grad_school', 'startup', 'military', 'campus_life', 'role'])
/**
 * 소속 표시 범위(A-05, @peerchive/domain AFFILIATION_LABEL_SCOPES). institution(`○○대 · 졸업생`) → institution_kind(`대학 졸업생`) → none(표시 안 함)
 * 순으로 넓습니다. 작성자가 고른 값(requested)보다 좁게 표시하는 경우는 없습니다(check).
 */
export const affiliationLabelScope = pgEnum('affiliation_label_scope', ['institution', 'institution_kind', 'none'])
/** 수료 회고 작성자 표시(A-06, ADR 0043, @peerchive/domain COMPLETION_RETRO_DISPLAY_MODES): 계정 이름 / 표시명 페르소나 이름 / 익명("익명 수료생"). */
export const completionRetroDisplayMode = pgEnum('completion_retro_display_mode', ['name', 'display', 'anonymous'])
/** 수료 회고 상태(A-06). 쓰는 순간 published, 작성자 철회 withdrawn, 운영 조치 hidden. */
export const completionRetroStatus = pgEnum('completion_retro_status', ['published', 'withdrawn', 'hidden'])
/** 사용자 방 템플릿(A-01, ADR 0038). alumni = 동문회·OB 방(방별 프로필·신분 배지). */
export const communitySpaceTemplate = pgEnum('community_space_template', ['general', 'alumni'])
/** 동문회·OB 방 일정의 반복 규칙(A-02, ADR 0039, @peerchive/domain ROOM_EVENT_RECURRENCES). 회차는 저장하지 않고 규칙에서 계산합니다. */
export const roomEventRecurrence = pgEnum('room_event_recurrence', ['none', 'weekly', 'monthly'])
/** 일정 상태(A-02). 취소한 일정은 남기되 응답을 받지 않습니다. */
export const roomEventStatus = pgEnum('room_event_status', ['scheduled', 'cancelled'])
/** 참석 응답(A-02, @peerchive/domain RSVP_RESPONSES): 참석 / 불참 / 미정. */
export const rsvpResponse = pgEnum('rsvp_response', ['going', 'not_going', 'maybe'])
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
/** 이름 표시 방식 변경 상태(C-03): scheduled(7일 대기) → applied(worker 적용) / cancelled(방장이 기한 전 취소). */
export const nameModeChangeStatus = pgEnum('name_mode_change_status', ['scheduled', 'applied', 'cancelled'])
/** 커뮤니티 알림 종류(C-03, @peerchive/domain COMMUNITY_NOTICE_KINDS). */
export const communityNoticeKind = pgEnum('community_notice_kind', [
  'name_mode_scheduled',
  'name_mode_cancelled',
  'name_mode_applied',
  'post_commented',
  'item_auto_hidden',
  'item_restored',
  'recruitment_invited',
  'recruitment_not_selected',
  'recruitment_cancelled',
  'archive_consent_requested',
  'archive_transfer_done',
  'archive_transfer_cancelled',
])
/** 커뮤니티 글·댓글 상태(C-04). auto_hidden은 C-06(신고 누적 임시 숨김)이 씁니다. */
export const communityItemStatus = pgEnum('community_item_status', ['published', 'deleted_by_author', 'hidden', 'auto_hidden'])
/** 공감 종류(C-04). 공감만, 비추천 없음. */
export const communityReactionKind = pgEnum('community_reaction_kind', ['empathy'])
/** 이용 제한 범위(C-06, @peerchive/domain SANCTION_SCOPES): 커뮤니티 전체 / 공간 하나. */
export const communitySanctionScope = pgEnum('community_sanction_scope', ['community', 'space'])
/** 이용 제한 수준(C-06, SANCTION_LEVELS): 경고(알림만) / 쓰기 기간 제한 / 영구 제한(커뮤니티 전체). */
export const communitySanctionLevel = pgEnum('community_sanction_level', ['warning', 'write_suspended', 'permanent'])
/** 방 운영진의 제재 요청 상태(C-06): 접수 → 처리(제재 발급)/기각. */
export const sanctionRequestStatus = pgEnum('sanction_request_status', ['open', 'resolved', 'dismissed'])
/** 모집 종류(C-07, @peerchive/domain RECRUITMENT_KINDS): 팀원 찾기 / 스터디 모집. 같은 테이블입니다(§8.8·§8.9.5). */
export const recruitmentKind = pgEnum('recruitment_kind', ['team', 'study'])
/** 모집 상태(C-07): 모집 중 → 마감(과제 공간·스터디 방 생성) / 취소. */
export const recruitmentStatus = pgEnum('recruitment_status', ['open', 'closed', 'cancelled'])
/** 지원 상태(C-07): 검토 중 → 선정 / 선정되지 않음(사유 없음) / 지원 취소. */
export const applicationStatus = pgEnum('application_status', ['pending', 'accepted', 'declined', 'withdrawn'])
export const archiveTransferTarget = pgEnum('archive_transfer_target', ['course_qa', 'stuck_log', 'senior_note'])
export const archiveTransferStatus = pgEnum('archive_transfer_status', ['awaiting_consent', 'done', 'cancelled'])
/** 과목 허브 단계적 개방(E-02)의 본인 알림 행: 열리면 알려 주기 신청 / 선배 노트 요청 닫음. */
export const courseHubNoticeKind = pgEnum('course_hub_notice_kind', ['open_notify', 'note_request'])
/** 학생 큐레이터(E-03)의 개념 태그 병합 제안 상태: 운영자 대기 → 승인(운영자가 병합 실행) / 거절. */
export const conceptTagProposalStatus = pgEnum('concept_tag_proposal_status', ['pending', 'approved', 'rejected'])
/** 학생 큐레이터(E-03)의 1차 신고 검토 의견: 기각 권장 / 가리기 권장. 처리는 운영자만 합니다. */
export const curatorRecommendation = pgEnum('curator_recommendation', ['dismiss', 'hide'])
/** 막힘 Q&A 스레드(E-04)의 글 종류: 스레드를 여는 질문 / 답변(질문자의 덧붙임 포함). @peerchive/domain STUCK_QA_POST_KINDS. */
export const stuckQaPostKind = pgEnum('stuck_qa_post_kind', ['question', 'answer'])
/** 막힘 Q&A 글 상태(E-04): 게시 / 작성자가 지움(탈퇴 정리 포함, 본문을 비움) / 운영 조치 hide_stuck_qa_post. */
export const stuckQaPostStatus = pgEnum('stuck_qa_post_status', ['published', 'withdrawn', 'hidden'])

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
    /**
     * 선택 실명(C-03, SYSTEM_DESIGN §6.7 "실명"). 신분 확인 없음. real 방식으로 쓴 커뮤니티 글·댓글의 작성자 표시에만 쓰고 공개 DTO·프로필·검색에는
     * 싣지 않습니다(본인 /me에만). 탈퇴 정리 때 지웁니다.
     */
    realName: text('real_name'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_private_email_lower_key').on(sql`lower(${t.privateEmail})`),
    check('users_real_name_check', sql`${t.realName} is null or char_length(${t.realName}) between 1 and 30`),
  ],
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

/**
 * 페르소나(S-01, SYSTEM_DESIGN §6.7.1 Persona, ADR 0028). 계정당 `real` 하나·`display` 하나까지이고 handle은 두 종류가 같은 전역 공간에서 유일합니다.
 * - `real`의 이름은 계정 표시 이름(`users.display_name`)이라 display_name을 두지 않습니다(같은 값을 두 곳에 두지 않음). `display`만 자기 이름을 가집니다.
 * - handle의 원본은 이 행입니다. profiles.handle은 복합 외래 키(ON UPDATE CASCADE)로 묶인 사본이라 따로 바꿀 수 없습니다.
 * - 이 행과 공개 DTO에는 같은 사용자의 다른 페르소나 id를 두지 않습니다. 두 페르소나의 연결은 identity_links에만 있습니다.
 */
export const personas = pgTable(
  'personas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: personaKind('kind').notNull(),
    handle: text('handle').notNull(),
    /** display 페르소나의 표시명(1~50자). real은 null(users.display_name을 씀). */
    displayName: text('display_name'),
    accountPrivacy: personaAccountPrivacy('account_privacy').notNull().default('public'),
    /** 공개 DTO에 팔로워 수를 실을지(팔로우는 S-04). */
    showFollowerCount: boolean('show_follower_count').notNull().default(true),
    status: personaStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('personas_user_kind_key').on(t.userId, t.kind),
    // 두 종류가 같은 전역 공간에서 유일(대소문자는 아래 check가 소문자만 허용해 따로 접지 않습니다).
    unique('personas_handle_key').on(t.handle),
    // profiles의 (persona_id, persona_kind, handle)·(persona_id, user_id), identity_links·portfolio_editions의 (persona_id, user_id) 복합 외래 키 대상.
    unique('personas_id_kind_handle_key').on(t.id, t.kind, t.handle),
    unique('personas_id_user_key').on(t.id, t.userId),
    // project_listings의 (persona_id, persona_kind) 복합 외래 키 대상(S-03): 과제 수행 목록은 실명 페르소나에만.
    unique('personas_id_kind_key').on(t.id, t.kind),
    check('personas_handle_format_check', sql`${t.handle} ~ '^[a-z0-9-]{3,30}$'`),
    check(
      'personas_display_name_check',
      sql`(${t.kind} = 'real' and ${t.displayName} is null) or (${t.kind} = 'display' and char_length(${t.displayName}) between 1 and 50)`,
    ),
  ],
)

/**
 * 프로필(§6.1, S-01부터 페르소나마다 하나, ADR 0028). 한 줄 소개·관심 직무·연락 정책 등은 페르소나별입니다.
 * - 기본 키는 persona_id입니다. **user_id는 real 페르소나의 프로필에만 채웁니다**(display는 null, check). 과제 공간·커뮤니티 멤버 목록처럼
 *   `profiles.user_id = users.id`로 handle을 붙이는 내부 조회가 표시명 프로필을 절대 집지 않게 하려는 것입니다.
 * - handle은 personas.handle의 사본입니다. (persona_id, persona_kind, handle) 복합 외래 키가 ON UPDATE CASCADE라 페르소나 handle을 바꾸면
 *   같은 문장에서 따라 바뀌고, 이 열만 다르게 바꾸는 update는 외래 키 위반입니다.
 */
export const profiles = pgTable(
  'profiles',
  {
    personaId: uuid('persona_id').primaryKey(),
    personaKind: personaKind('persona_kind').notNull(),
    /** real 페르소나의 프로필만(display는 null). 내부 조회의 `profiles.user_id = users.id` 조인이 실명 프로필만 집습니다. */
    userId: uuid('user_id').references(() => users.id),
    handle: text('handle').notNull().unique(),
    headline: text('headline'),
    jobTargets: text('job_targets').array().notNull().default(sql`'{}'::text[]`),
    /** 선택 입력. 학교 인증 의미 없음. */
    schoolLabel: text('school_label'),
    gradTerm: text('grad_term'),
    contactPolicy: contactPolicy('contact_policy').notNull().default('closed'),
    openToWork: boolean('open_to_work').notNull().default(false),
    /**
     * 운영 조치로 공개 프로필을 숨긴 시각(T-15). 숨김이면 /u/:handle·README 카드·이전 공개 프로필 API가 404입니다. 계정·과제 공간은 그대로입니다.
     * 페르소나마다 따로입니다: 실명 프로필을 숨겨도 표시명 프로필은 그대로(함께 사라지면 같은 사람임이 드러남, ADR 0028).
     */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    /** 공개 프로필에 학교 인증 배지("○○대학교 인증", 졸업생이면 "졸업생")를 보일지(C-01, 기본 끔). 학과·메일·도메인은 어떤 경우에도 공개하지 않습니다. */
    showAffiliationBadge: boolean('show_affiliation_badge').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // 세부 규칙(예약어, 앞뒤 하이픈)은 애플리케이션이 검증하고, DB는 문자 집합·길이만 막습니다.
  (t) => [
    check('profiles_handle_format_check', sql`${t.handle} ~ '^[a-z0-9-]{3,30}$'`),
    check('profiles_user_kind_check', sql`(${t.personaKind} = 'real') = (${t.userId} is not null)`),
    unique('profiles_user_id_key').on(t.userId),
    foreignKey({
      name: 'profiles_persona_handle_fk',
      columns: [t.personaId, t.personaKind, t.handle],
      foreignColumns: [personas.id, personas.kind, personas.handle],
    }).onUpdate('cascade'),
    // user_id가 null(display)이면 MATCH SIMPLE이라 검사하지 않고, real이면 그 페르소나의 주인과 같아야 합니다.
    foreignKey({
      name: 'profiles_persona_user_fk',
      columns: [t.personaId, t.userId],
      foreignColumns: [personas.id, personas.userId],
    }),
  ],
)

/**
 * 표시명 ↔ 실명 연결 플래그(S-01, SYSTEM_DESIGN §6.7.1 IdentityLink, ADR 0028). 사용자마다 하나이며 display 페르소나를 만들 때 visible = false로 생깁니다.
 * visible = false이면 어떤 공개 DTO·HTML·OG·인쇄 보기·README 카드도 두 페르소나를 함께 내보내지 않습니다(@peerchive/domain canSeeIdentityLink).
 * 켜고 끈 이력은 감사 이벤트(`persona.identity_link_update`, 플래그만)로만 남깁니다.
 */
export const identityLinks = pgTable(
  'identity_links',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    realPersonaId: uuid('real_persona_id').notNull(),
    displayPersonaId: uuid('display_persona_id').notNull(),
    visible: boolean('visible').notNull().default(false),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('identity_links_real_persona_key').on(t.realPersonaId),
    unique('identity_links_display_persona_key').on(t.displayPersonaId),
    check('identity_links_distinct_check', sql`${t.realPersonaId} <> ${t.displayPersonaId}`),
    foreignKey({ name: 'identity_links_real_persona_fk', columns: [t.realPersonaId, t.userId], foreignColumns: [personas.id, personas.userId] }),
    foreignKey({ name: 'identity_links_display_persona_fk', columns: [t.displayPersonaId, t.userId], foreignColumns: [personas.id, personas.userId] }),
  ],
)

/**
 * 페르소나 활동(S-02, SYSTEM_DESIGN §6.7.1 PersonaActivity·§8.3 불변조건 1, ADR 0029). 공개 프로필의 활동 목록과 팔로우 피드(S-05)가 읽는 **유일한 원천**입니다.
 * - persona_id NOT NULL: 페르소나가 없는 0~1단계(익명) 글은 이 테이블에 들어올 자리가 없습니다.
 * - 원본 모듈이 투영합니다(@peerchive/domain decidePersonaActivityProjection → social `projectPersonaActivity`). 커뮤니티 글은 이름 표시 방식이
 *   real·display이고 listed 공간의 글만, 익명 선배 노트·익명 스터디 release는 투영하지 않습니다.
 * - **DB 트리거(persona_activities_projection_guard, migration 0027)가 같은 규칙을 원본 행으로 한 번 더 확인합니다**: 커뮤니티 글이면 그 글의
 *   작성 시점 persona_id·방식·상태·공간 노출을 보고, 아니면 INSERT를 거부합니다. 그래서 애플리케이션 어디서 넣든 익명 글은 들어오지 못합니다.
 *   투영한 뒤에는 withdrawn_at만 바꿀 수 있습니다(같은 트리거).
 * - source_id는 원천마다 다른 테이블을 가리키므로 외래 키가 없습니다. item_kind는 공개 범위 항목(§6.7.1 VisibilitySetting) 대응이며 원천 종류로 정해집니다(check).
 * - created_at은 원천의 시각(글 작성·release 게시 시각)이고, 숨김·삭제·철회·방식 재선택은 withdrawn_at을 채웁니다(행은 남김, S-05).
 * - S-05(migration 0031, ADR 0035): 거두기는 원본 테이블(커뮤니티 글·공간 노출·선배 노트·공개 후보·동의·프로필 글)의 상태가 바뀌는 같은 트랜잭션의
 *   트리거가 하고, 공개 상태로 돌아오면 원천을 다시 확인해 되살립니다. 읽기는 `persona_activity_cards`가 원본을 다시 봅니다.
 */
export const personaActivities = pgTable(
  'persona_activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personaId: uuid('persona_id')
      .notNull()
      .references(() => personas.id),
    sourceType: personaActivitySource('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    itemKind: text('item_kind').notNull(),
    createdAt: createdAt(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [
    unique('persona_activities_source_key').on(t.personaId, t.sourceType, t.sourceId),
    index('persona_activities_persona_created_idx').on(t.personaId, t.createdAt.desc()).where(sql`${t.withdrawnAt} is null`),
    index('persona_activities_source_idx').on(t.sourceType, t.sourceId),
    check(
      'persona_activities_item_kind_check',
      sql`(${t.sourceType} = 'publication_release' and ${t.itemKind} = 'cases')
        or (${t.sourceType} in ('senior_note', 'study_release') and ${t.itemKind} = 'notes_and_studies')
        or (${t.sourceType} in ('profile_post', 'community_post') and ${t.itemKind} = 'posts')`,
    ),
  ],
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
 * I-01(ADR 0037): 이 표가 기관(Institution)입니다. kind가 university가 아닌 행(부트캠프 등)은 운영자만 만들고, 과목·학교 검색에는 나오지 않습니다.
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
    /** 기관 종류(I-01). 학생이 만드는 학교는 언제나 university. */
    kind: institutionKind('kind').notNull().default('university'),
    createdAt: createdAt(),
  },
  (t) => [
    index('schools_kind_idx').on(t.kind),
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
    /**
     * 수업이 팀을 배정하는 과목이라 팀원 찾기를 숨김(C-07, PROOFU_EVOLUTION_PLAN §8.8 "과목 큐레이터가 표시"). 운영자 또는 그 과목 학생 큐레이터(E-03, ADR 0048)가 정합니다.
     * 정본 과목의 값만 봅니다. 공개 과목 허브 응답에는 싣지 않습니다.
     */
    teamFindingDisabled: boolean('team_finding_disabled').notNull().default(false),
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
     * 스터디 기록(kind = study, C-08, ADR 0026)일 때만: 연결된 스터디 방의 지금 이름 표시 방식을 옮겨 둔 값입니다.
     * 커뮤니티 모듈(기록 켜기)과 worker(이름 표시 방식 변경 적용)만 같은 트랜잭션에서 씁니다. 공개 후보는 만들 때 이 값을 스냅샷에 고정하고,
     * anonymous면 공개 이름 노출·케이스 스터디(포트폴리오)·공개 프로필 연결을 막습니다. 과제 쪽 모듈은 커뮤니티 테이블을 읽지 않고 이 열만 봅니다.
     */
    studyNameMode: communityNameMode('study_name_mode'),
    /**
     * 스터디 기록일 때만: 연결된 스터디 방의 정본 학교(학교 무관 방이면 null). C-05 열람 범위와 같게, 기록을 읽으려면 과제 멤버이면서
     * 이 학교(null이면 아무 학교)의 active 학교 인증이 있어야 합니다(인증을 해제하면 다음 요청부터 404). 방의 학교는 바뀌지 않습니다.
     */
    studySchoolId: uuid('study_school_id').references(() => schools.id),
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
    check('projects_study_name_mode_check', sql`(${t.kind}::text = 'study') = (${t.studyNameMode} is not null)`),
    check('projects_study_school_check', sql`${t.studySchoolId} is null or ${t.kind}::text = 'study'`),
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
    // project_listings의 (project_member_id, user_id) 복합 외래 키 대상(S-03): 목록 행의 멤버와 페르소나 주인이 같은 사람임을 DB가 보장합니다.
    unique('project_members_id_user_key').on(t.id, t.userId),
  ],
)

// ── 항목별 공개 범위·과제 수행 목록 (S-03, SYSTEM_DESIGN §6.7.1, ADR 0031) ──

/**
 * 항목별 공개 범위(S-03, SYSTEM_DESIGN §6.7.1 VisibilitySetting, ADR 0031). 페르소나·항목마다 하나이며, **행이 없으면 기본값**
 * (@peerchive/domain defaultAudience: project_list = private, 글·노트는 공개 계정 signed_in / 비공개 계정 approved_followers, 팔로우 목록 private)을
 * 계산해 씁니다. 바꾼 항목만 행으로 남습니다. 비공개 계정은 저장 값과 관계없이 approved_followers 이하로 좁혀 적용합니다(effectiveAudience).
 * 공개 사례·케이스 스터디는 이 표의 항목이 아니라서 이 설정으로 넓힐 수 없습니다.
 */
export const visibilitySettings = pgTable(
  'visibility_settings',
  {
    personaId: uuid('persona_id')
      .notNull()
      .references(() => personas.id),
    itemKind: visibilityItemKind('item_kind').notNull(),
    audience: visibilityAudience('audience').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'visibility_settings_pkey', columns: [t.personaId, t.itemKind] }),
    check('visibility_settings_follow_lists_check', sql`${t.itemKind} <> 'follow_lists' or ${t.audience} in ('public', 'private')`),
  ],
)

/**
 * 과제 수행 목록(S-03, SYSTEM_DESIGN §6.7.1 ProjectListing, ADR 0031). 멤버가 직접 고른 과제만 실명 페르소나의 공개 프로필에 나옵니다.
 * - 노출 필드는 과목·학기·`projects.title`뿐이고, 엠바고 중이면 제목 없이 과목·학기만입니다(읽을 때마다 계산).
 * - **실명 페르소나만**(persona_kind check): 표시명 프로필에 팀 과제를 올리면 팀원이 두 프로필을 이을 수 있습니다(ADR 0028·0031).
 * - user_id는 두 복합 외래 키로 멤버십의 주인 = 페르소나의 주인을 DB가 보장하려고 둔 사본입니다(공개 DTO에는 싣지 않음).
 * - 숨기면 hidden_at을 채우고(행은 남김), 다시 보이면 shown_at을 새로 쓰고 hidden_at을 비웁니다. 익명 스터디 방 과제 거부와 active 멤버 조건은
 *   애플리케이션(@peerchive/domain listingBlock)이 쓸 때와 읽을 때 모두 확인합니다.
 */
export const projectListings = pgTable(
  'project_listings',
  {
    projectMemberId: uuid('project_member_id').notNull(),
    personaId: uuid('persona_id').notNull(),
    personaKind: personaKind('persona_kind').notNull().default('real'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    shownAt: timestamp('shown_at', { withTimezone: true }).notNull().defaultNow(),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'project_listings_pkey', columns: [t.projectMemberId, t.personaId] }),
    index('project_listings_persona_idx').on(t.personaId).where(sql`${t.hiddenAt} is null`),
    check('project_listings_real_persona_check', sql`${t.personaKind} = 'real'`),
    foreignKey({ name: 'project_listings_member_fk', columns: [t.projectMemberId, t.userId], foreignColumns: [projectMembers.id, projectMembers.userId] }),
    foreignKey({ name: 'project_listings_persona_fk', columns: [t.personaId, t.userId], foreignColumns: [personas.id, personas.userId] }),
    foreignKey({ name: 'project_listings_persona_kind_fk', columns: [t.personaId, t.personaKind], foreignColumns: [personas.id, personas.kind] }),
  ],
)

// ── 팔로우·차단·뮤트 (S-04, SYSTEM_DESIGN §6.7.1 Follow·Block·Mute·§8.3, ADR 0033) ──

/**
 * 팔로우(S-04, SYSTEM_DESIGN §6.7.1 Follow, ADR 0033). 팔로우하는 쪽과 받는 쪽 모두 **페르소나**입니다: 표시명으로 팔로우하면 상대의 팔로워 목록에는
 * 표시명만 보입니다. `(follower_persona_id, followee_persona_id)` 유일.
 * - follower_user_id·followee_user_id는 두 복합 외래 키 `(persona_id, user_id) → personas(id, user_id)`로 페르소나의 주인과 같음이 보장되는
 *   사본이고, **check `follower_user_id <> followee_user_id`로 자기 페르소나(같은 사용자의 다른 페르소나 포함) 팔로우를 DB가 막습니다.**
 *   공개 DTO에는 싣지 않습니다.
 * - 비공개 계정은 pending으로 생겨 주인이 승인하면 active(approved_at)가 됩니다. 거절·팔로워 삭제·언팔로우는 행 삭제이고 상대에게 알리지 않습니다.
 */
export const follows = pgTable(
  'follows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    followerPersonaId: uuid('follower_persona_id').notNull(),
    followerUserId: uuid('follower_user_id').notNull(),
    followeePersonaId: uuid('followee_persona_id').notNull(),
    followeeUserId: uuid('followee_user_id').notNull(),
    status: followStatus('status').notNull().default('pending'),
    createdAt: createdAt(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => [
    unique('follows_pair_key').on(t.followerPersonaId, t.followeePersonaId),
    check('follows_not_self_check', sql`${t.followerUserId} <> ${t.followeeUserId}`),
    check('follows_approved_check', sql`(${t.status} = 'active') = (${t.approvedAt} is not null)`),
    foreignKey({ name: 'follows_follower_persona_fk', columns: [t.followerPersonaId, t.followerUserId], foreignColumns: [personas.id, personas.userId] }),
    foreignKey({ name: 'follows_followee_persona_fk', columns: [t.followeePersonaId, t.followeeUserId], foreignColumns: [personas.id, personas.userId] }),
    index('follows_followee_idx').on(t.followeePersonaId, t.status),
    index('follows_follower_user_idx').on(t.followerUserId),
    index('follows_followee_user_idx').on(t.followeeUserId),
  ],
)

/**
 * 차단(S-04, SYSTEM_DESIGN §6.7.1 Block, ADR 0033). **저장은 사용자 단위**(blocker_user_id → blocked_user_id)이고, 숨김 범위는 기본으로 차단을 건
 * 내 페르소나(origin_persona_id)이며 `all_personas`는 사용자가 고를 때만입니다. 숨겨진 페르소나는 차단당한 사용자에게 404입니다.
 * - blocked_persona_id는 차단한 사람이 차단을 건 **상대의 페르소나 페이지**입니다. 내 차단 목록에 그 handle만 보여 주고(상대의 다른 페르소나를
 *   드러내지 않음), 같은 상대의 다른 페르소나를 다시 차단해도 "이미 차단함"으로 연결을 알려 주지 않도록 유일 키에 넣습니다.
 *   blocked_user_id는 서버만 쓰며 어떤 응답에도 싣지 않습니다.
 * - 두 복합 외래 키가 origin 페르소나의 주인 = blocker, 대상 페르소나의 주인 = blocked임을 보장하고, check가 자기 차단을 막습니다.
 * - 0~1단계(익명) 커뮤니티 글에는 적용하지 않습니다(커뮤니티 모듈은 이 표를 읽지 않음).
 */
export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockerUserId: uuid('blocker_user_id').notNull(),
    blockedUserId: uuid('blocked_user_id').notNull(),
    originPersonaId: uuid('origin_persona_id').notNull(),
    blockedPersonaId: uuid('blocked_persona_id').notNull(),
    scope: blockScope('scope').notNull().default('origin_persona'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('blocks_origin_target_key').on(t.blockerUserId, t.originPersonaId, t.blockedPersonaId),
    check('blocks_not_self_check', sql`${t.blockerUserId} <> ${t.blockedUserId}`),
    foreignKey({ name: 'blocks_origin_persona_fk', columns: [t.originPersonaId, t.blockerUserId], foreignColumns: [personas.id, personas.userId] }),
    foreignKey({ name: 'blocks_blocked_persona_fk', columns: [t.blockedPersonaId, t.blockedUserId], foreignColumns: [personas.id, personas.userId] }),
    index('blocks_blocked_user_idx').on(t.blockedUserId, t.blockerUserId),
  ],
)

/**
 * 뮤트(S-04, SYSTEM_DESIGN §6.7.1 Mute, ADR 0033). 팔로우 피드·알림(S-05)에서만 제외하며 지금은 저장과 "내 뮤트 목록"만 있습니다. 상대에게 알리지 않습니다.
 * muted_user_id는 복합 외래 키로 대상 페르소나의 주인임이 보장되는 사본이고, check가 자기 페르소나 뮤트를 막습니다(응답에 싣지 않음).
 */
export const mutes = pgTable(
  'mutes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    muterUserId: uuid('muter_user_id')
      .notNull()
      .references(() => users.id),
    mutedPersonaId: uuid('muted_persona_id').notNull(),
    mutedUserId: uuid('muted_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('mutes_pair_key').on(t.muterUserId, t.mutedPersonaId),
    check('mutes_not_self_check', sql`${t.muterUserId} <> ${t.mutedUserId}`),
    foreignKey({ name: 'mutes_muted_persona_fk', columns: [t.mutedPersonaId, t.mutedUserId], foreignColumns: [personas.id, personas.userId] }),
  ],
)

/**
 * 소셜 링크(S-06, SYSTEM_DESIGN §6.7.1 SocialLink, ADR 0034). **페르소나마다 따로**이고 한 링크는 한 페르소나에만 속합니다.
 * - user_id는 페르소나 주인의 사본입니다. 복합 외래 키 (persona_id, user_id)가 사본 = 주인을 보장하고, 유일 키 (user_id, url)가 같은 사용자의
 *   다른 페르소나에 같은 주소를 거는 것을 막습니다(두 프로필이 같은 외부 계정으로 이어지면 연결 플래그와 무관하게 같은 사람임이 드러남).
 * - url은 @peerchive/domain parseSocialLinkUrl이 정규화한 https 주소입니다(바꾸지 않음: 고치려면 지우고 다시 추가). 웹 서버는 이 주소에 접속하지 않고,
 *   되돌림 링크 확인은 worker의 링크 수집기만 합니다(§10).
 * - check_failures는 연속 가져오기 실패 수입니다. verified 링크가 3번 연속 실패하면 lost(@peerchive/domain nextSocialLinkState).
 * - 감사에는 id·서비스·페르소나 종류만 남기고 주소는 남기지 않습니다.
 */
export const socialLinks = pgTable(
  'social_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personaId: uuid('persona_id').notNull(),
    userId: uuid('user_id').notNull(),
    provider: socialLinkProvider('provider').notNull(),
    url: text('url').notNull(),
    verification: socialLinkVerification('verification').notNull().default('unverified'),
    /** verified가 된 시각(verified인 동안 그대로). verified가 아니면 null. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** 마지막으로 수집기가 확인한 시각(성공·실패 모두). */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheckResult: socialLinkCheckResult('last_check_result'),
    checkFailures: integer('check_failures').notNull().default(0),
    /** 마지막 확인 요청 시각. 이보다 늦은 last_checked_at이 없으면 화면은 "확인 중"으로 봅니다. */
    verifyRequestedAt: timestamp('verify_requested_at', { withTimezone: true }),
    /**
     * 운영 조치로 숨긴 시각(S-07 hide_social_link, ADR 0036). 숨긴 링크는 공개 DTO에서 빠지고, 본인 화면에는 "운영 조치로 숨김"으로 보입니다.
     * 숨긴 동안 본인이 지울 수 없습니다(409 hidden — 지우고 같은 주소로 다시 붙여 조치를 피하지 못하게, 조치 근거 보존).
     */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('social_links_user_url_key').on(t.userId, t.url),
    check('social_links_url_check', sql`${t.url} like 'https://%' and char_length(${t.url}) <= 300`),
    check('social_links_verified_at_check', sql`(${t.verification} = 'verified') = (${t.verifiedAt} is not null)`),
    check('social_links_failures_check', sql`${t.checkFailures} >= 0`),
    foreignKey({ name: 'social_links_persona_fk', columns: [t.personaId, t.userId], foreignColumns: [personas.id, personas.userId] }),
    index('social_links_persona_idx').on(t.personaId, t.createdAt),
    index('social_links_recheck_idx').on(t.lastCheckedAt).where(sql`${t.verification} = 'verified'`),
  ],
)

/**
 * 프로필 글(S-05, SYSTEM_DESIGN §6.7.1 ProfilePost, ADR 0035). 페르소나의 프로필에 직접 쓰는 짧은 글이고 노출은 그 페르소나의 `posts` 공개 범위를 따릅니다.
 * - user_id는 페르소나 주인의 사본입니다(복합 외래 키 (persona_id, user_id)). 공개 응답에는 싣지 않습니다.
 * - 지우기는 status = deleted(본문을 비움), 운영 숨김은 hidden(S-07). 상태가 published를 떠나면 같은 트랜잭션의 DB 트리거가 페르소나 활동의
 *   withdrawn_at을 채웁니다(migration 0031).
 * - media_version_ids: 설계의 "§10 파일 검사를 거친 버전만" 자리입니다. 이번 범위는 글만이라 빈 배열만 받습니다(check, 후속 ADR 0035).
 */
export const profilePosts = pgTable(
  'profile_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personaId: uuid('persona_id').notNull(),
    userId: uuid('user_id').notNull(),
    body: text('body').notNull(),
    mediaVersionIds: uuid('media_version_ids').array().notNull().default(sql`'{}'::uuid[]`),
    status: profilePostStatus('status').notNull().default('published'),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: 'profile_posts_persona_fk', columns: [t.personaId, t.userId], foreignColumns: [personas.id, personas.userId] }),
    index('profile_posts_persona_created_idx').on(t.personaId, t.createdAt.desc()).where(sql`${t.status} = 'published'`),
    index('profile_posts_user_idx').on(t.userId),
    // 지운 글은 본문을 비웁니다. 게시 중·숨김 글은 1~500자(@peerchive/domain PROFILE_POST_MAX).
    check('profile_posts_body_check', sql`(${t.status} = 'deleted' and ${t.body} = '') or (${t.status} <> 'deleted' and char_length(${t.body}) between 1 and 500)`),
    check('profile_posts_deleted_check', sql`(${t.status} = 'deleted') = (${t.deletedAt} is not null)`),
    check('profile_posts_media_check', sql`cardinality(${t.mediaVersionIds}) = 0`),
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
    // log_comments의 (log_entry_id, project_id) 복합 외래 키 대상(E-10).
    unique('log_entries_id_project_key').on(t.id, t.projectId),
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

/**
 * 로그별 피드백 댓글(E-10, ADR 0054). revision이 아니라 로그(entry)에 붙어 로그를 고쳐도 남습니다. revision_no는 쓸 때 현재였던 revision(맥락 표시용).
 * 팀 안에서만 읽고 쓰며 공개 스냅샷(ADR 0011 허용 목록)·공개 DTO·검색·케이스·기여 장부에 넣지 않습니다.
 * project_id는 로그의 과제와 같음을 복합 외래 키로 강제합니다(과제 단위 정리·조회용).
 * 지우면(작성자·탈퇴 정리) 본문을 비우고 행은 남겨 스레드 자리를 유지합니다. 작성자 칸은 탈퇴 때 가명 처리된 users를 가리킵니다(ADR 0016 팀 기록 규칙).
 */
export const logComments = pgTable(
  'log_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    logEntryId: uuid('log_entry_id').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /** 쓸 때 로그의 현재 revision 번호(맥락 표시용, 바뀌지 않음). */
    revisionNo: integer('revision_no').notNull(),
    body: text('body').notNull(),
    status: logCommentStatus('status').notNull().default('published'),
    createdAt: createdAt(),
    /** 작성자가 본문을 마지막으로 고친 시각(고친 적 없으면 null). */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'log_comments_log_entry_project_fk',
      columns: [t.logEntryId, t.projectId],
      foreignColumns: [logEntries.id, logEntries.projectId],
    }),
    index('log_comments_entry_created_idx').on(t.logEntryId, t.createdAt, t.id),
    index('log_comments_project_idx').on(t.projectId),
    index('log_comments_author_idx').on(t.authorId),
    check('log_comments_revision_no_check', sql`${t.revisionNo} >= 1`),
    check(
      'log_comments_body_check',
      sql`(${t.status}::text = 'deleted' and ${t.body} = '') or (${t.status}::text <> 'deleted' and char_length(${t.body}) between 1 and 2000)`,
    ),
    check('log_comments_deleted_check', sql`(${t.status}::text = 'deleted') = (${t.deletedAt} is not null)`),
    check('log_comments_hidden_check', sql`(${t.status}::text = 'hidden') = (${t.hiddenAt} is not null)`),
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
 * - affiliation_label(A-06, ADR 0043): 토픽 답변(소속 표시 익명)을 옮겨 만든 노트에 원 글의 **작성 시점에 고정된 소속 표시를 그대로 복사**한 문자열
 *   (다시 계산하지 않음). display_mode = affiliation이면 이 문자열만 작성자 표시로 보이고 페르소나로 투영되지 않습니다. 다른 방식으로 바꿔도 값은 남아
 *   (작성자가 다시 소속 표시로 돌아갈 수 있게) 공개 응답에는 affiliation 방식일 때만 실립니다.
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
    affiliationLabel: text('affiliation_label'),
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
    // A-06: 소속 표시 방식은 복사한 소속 표시가 있을 때만, 이름 사본은 없음(affiliation은 같은 migration에서 더한 값이라 text로 비교).
    check(
      'senior_notes_affiliation_label_check',
      sql`(${t.affiliationLabel} is null or char_length(${t.affiliationLabel}) between 1 and 100)
        and (${t.displayMode}::text <> 'affiliation' or (${t.affiliationLabel} is not null and ${t.displayNameSnapshot} is null))`,
    ),
    check('senior_notes_published_check', sql`${t.status} <> 'published' or ${t.publishedAt} is not null`),
  ],
)

/**
 * 막힘 Q&A(C-09, PROOFU_EVOLUTION_PLAN §8.5·§8.9.8, ADR 0025). 커뮤니티 질문 게시판의 질문 + 채택된 답변을 **두 사람의 동의를 받아 복사한**
 * 아카이브 행입니다(원 글은 커뮤니티에 그대로 남음).
 * - **커뮤니티 테이블을 가리키지 않습니다**(외래 키 없음): 공개 읽기(과목 허브·검색·신호)는 이 행만 읽고 커뮤니티 테이블과 조인할 길이 없습니다.
 *   어느 옮기기 요청에서 왔는지는 커뮤니티 쪽 archive_transfers.course_qa_item_id가 이 행을 가리키고, 여기에는 불투명한 transfer_id(외래 키 없음,
 *   공개 응답에 싣지 않음)만 둡니다.
 * - 글: 요청 때 얼린 질문 제목·본문·답변(복사본). 이름: 각자 고른 표시(asker_label·answerer_label, 익명이면 "질문한 학생"/"답한 학생").
 * - asker_id·answerer_id: 철회 권한(두 사람 모두 언제든)·운영 조치 안내·탈퇴 정리에만 씁니다. 공개 응답에 싣지 않습니다.
 * - 상태: published(공개) / withdrawn(당사자 철회·탈퇴 정리, 글을 비울 수 있음) / hidden(운영 조치 hide_qa). 공개 읽기는 published만 같은 쿼리에서 봅니다.
 */
export const courseQaItems = pgTable(
  'course_qa_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 정본 과목. 과목 병합 때 정본으로 옮깁니다. */
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    questionTitle: text('question_title').notNull(),
    questionBody: text('question_body').notNull(),
    answerBody: text('answer_body').notNull(),
    askerLabel: text('asker_label').notNull(),
    askerAnonymous: boolean('asker_anonymous').notNull(),
    answererLabel: text('answerer_label').notNull(),
    answererAnonymous: boolean('answerer_anonymous').notNull(),
    askerId: uuid('asker_id').references(() => users.id),
    answererId: uuid('answerer_id').references(() => users.id),
    status: courseQaStatus('status').notNull().default('published'),
    /** 어느 옮기기에서 왔는지(불투명한 id, 외래 키 없음). */
    transferId: uuid('transfer_id').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    /** asker / answerer / account_deleted. */
    withdrawnBy: text('withdrawn_by'),
  },
  (t) => [
    index('course_qa_items_course_published_idx').on(t.courseId, t.publishedAt.desc()),
    index('course_qa_items_asker_idx').on(t.askerId),
    index('course_qa_items_answerer_idx').on(t.answererId),
    check(
      'course_qa_items_content_check',
      sql`(char_length(${t.questionTitle}) between 1 and 120 and char_length(${t.questionBody}) between 1 and 10000 and char_length(${t.answerBody}) between 1 and 3000)
        or (${t.status}::text = 'withdrawn' and ${t.questionTitle} = '' and ${t.questionBody} = '' and ${t.answerBody} = '')`,
    ),
    check('course_qa_items_labels_check', sql`char_length(${t.askerLabel}) between 1 and 40 and char_length(${t.answererLabel}) between 1 and 40`),
    check('course_qa_items_withdrawn_check', sql`(${t.status}::text = 'withdrawn') = (${t.withdrawnAt} is not null)`),
    check('course_qa_items_withdrawn_by_check', sql`${t.withdrawnBy} is null or ${t.withdrawnBy} in ('asker', 'answerer', 'account_deleted')`),
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
    /** 막힘 Q&A(C-09). */
    courseQaItemId: uuid('course_qa_item_id').references(() => courseQaItems.id),
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
    // C-09: 막힘 Q&A 신호(사람·항목·종류마다 하나). 부분 조건에 새 enum 값을 쓰지 않으려고 열로 거릅니다.
    uniqueIndex('usefulness_signals_qa_key').on(t.userId, t.courseQaItemId, t.kind).where(sql`${t.courseQaItemId} is not null`),
    index('usefulness_signals_qa_idx').on(t.courseQaItemId),
    check(
      'usefulness_signals_target_check',
      sql`(${t.targetKind} = 'stuck_item' and ${t.publicationId} is not null and ${t.itemKey} is not null and ${t.seniorNoteId} is null and ${t.courseQaItemId} is null)
        or (${t.targetKind} = 'senior_note' and ${t.seniorNoteId} is not null and ${t.publicationId} is null and ${t.itemKey} is null and ${t.courseQaItemId} is null)
        or (${t.targetKind}::text = 'course_qa' and ${t.courseQaItemId} is not null and ${t.publicationId} is null and ${t.itemKey} is null and ${t.seniorNoteId} is null)`,
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
    /** 막힘 Q&A 문서(C-09). 검색은 이 행이 published일 때만 보여 줍니다. */
    courseQaItemId: uuid('course_qa_item_id').references(() => courseQaItems.id),
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
    uniqueIndex('search_documents_qa_key').on(t.courseQaItemId).where(sql`${t.courseQaItemId} is not null`),
    index('search_documents_publication_idx').on(t.publicationId),
    index('search_documents_search_text_trgm_idx').using('gin', t.searchText.op('gin_trgm_ops')),
    check(
      'search_documents_target_check',
      sql`(${t.kind} in ('case', 'stuck') and ${t.publicationId} is not null and ${t.releaseId} is not null and ${t.seniorNoteId} is null
          and ((${t.kind} = 'case') = (${t.itemKey} is null)))
        or (${t.kind} = 'note' and ${t.seniorNoteId} is not null and ${t.noteVersion} is not null and ${t.publicationId} is null and ${t.releaseId} is null)
        or (${t.kind}::text = 'qa' and ${t.courseQaItemId} is not null and ${t.publicationId} is null and ${t.releaseId} is null and ${t.seniorNoteId} is null)`,
    ),
  ],
)

// ── 이번 학기 과목 등록 (E-01, PROOFU_EVOLUTION_PLAN §8.7, DELIVERY_PLAN §4.4, ADR 0046) ─────────────

/**
 * 이번 학기 과목 등록 = (사용자, 개설 학기). 개설 학기가 과목을 정하므로 과목 id를 따로 두지 않습니다.
 * - **본인만 봅니다**: 공개 프로필·검색·페르소나·피드·추천·운영자 화면에 싣지 않습니다. 밖으로 나가는 값은 과목 허브의 "이번 학기 수강 중 N명"
 *   (정본 과목·지금 학기·active 계정의 서로 다른 사용자 수, 5명 미만이면 없음)뿐입니다. 감사 기록·분석 이벤트도 남기지 않습니다.
 * - 학기는 등록할 때 정본 학기로 둡니다. 과목 병합으로 학기가 합쳐지면 같은 트랜잭션에서 정본 학기로 옮깁니다(같은 사람이 이미 정본 학기에
 *   등록했으면 원본 쪽 행을 지움).
 * - post_term_prompted_at: 학기가 끝난 뒤 worker(`course-term-prompts`)가 한 번만 채우는 화면 안 알림("선배 노트를 남겨 주세요"·"공개할까요?").
 *   prompt_dismissed_at: 본인이 알림을 닫은 시각. 메일은 보내지 않습니다.
 * - 본인이 지우거나 탈퇴 정리 때 삭제합니다.
 */
export const courseRegistrations = pgTable(
  'course_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    courseTermId: uuid('course_term_id')
      .notNull()
      .references(() => courseTerms.id),
    postTermPromptedAt: timestamp('post_term_prompted_at', { withTimezone: true }),
    promptDismissedAt: timestamp('prompt_dismissed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('course_registrations_user_term_key').on(t.userId, t.courseTermId),
    index('course_registrations_course_term_idx').on(t.courseTermId),
    index('course_registrations_prompt_due_idx').on(t.courseTermId).where(sql`${t.postTermPromptedAt} is null`),
    check('course_registrations_dismissed_check', sql`${t.promptDismissedAt} is null or ${t.postTermPromptedAt} is not null`),
  ],
)

// ── 과목 허브 단계적 개방 (E-02, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4, ADR 0047) ─────────────

/**
 * 과목 허브 단계적 개방의 본인 알림 행. 허브가 열렸는지는 저장하지 않고 요청마다 계산합니다(course-hub/staged-opening.ts).
 * - kind = 'open_notify': "준비 중" 허브를 등록한 학생이 "열리면 알려 주세요"를 누른 행. 홈이 읽을 때 허브가 열렸으면 `opened_at`을 한 번 채우고
 *   (조건부 갱신이라 몇 번 읽어도 한 번) "열렸습니다" 알림을 보여 줍니다. 본인이 닫으면 `dismissed_at`.
 * - kind = 'note_request': 과목을 마친 학생에게 보이는 "선배 노트를 남겨 주세요"를 본인이 닫은 행(닫을 때만 만들어짐, `dismissed_at` 필수).
 * - **본인만 봅니다**: /me 경로만 읽고 쓰며, 신청 수는 어디에도(공개·운영자 화면 포함) 내보내지 않습니다. 감사 기록·분석 이벤트도 남기지 않습니다.
 * - course_id는 정본 과목. 과목 병합 때 같은 트랜잭션에서 정본으로 옮깁니다(같은 사람·종류가 이미 있으면 원본 쪽 행을 지움). 탈퇴 정리 때 삭제.
 */
export const courseHubNotices = pgTable(
  'course_hub_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    kind: courseHubNoticeKind('kind').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('course_hub_notices_user_course_kind_key').on(t.userId, t.courseId, t.kind),
    index('course_hub_notices_course_idx').on(t.courseId),
    check('course_hub_notices_opened_check', sql`${t.openedAt} is null or ${t.kind} = 'open_notify'`),
    check('course_hub_notices_note_request_check', sql`${t.kind} <> 'note_request' or ${t.dismissedAt} is not null`),
  ],
)

// ── 학생 큐레이터 (E-03, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4, ADR 0048) ─────────────
//
// 과목마다 그 과목을 마친 고학년·졸업생 1~2명. 개념 태그 병합 제안·과제 유형 요약·1차 신고 검토(의견만)·팀원 찾기 끄기만 하고, 공개 철회·
// 가리기·계정 조치·작성자 확인·신고 처리는 운영자만 합니다.

/**
 * 과목 큐레이터 지정. 운영자만 지정·해제(감사 id만). 정본 과목에 최대 2명(애플리케이션이 과목별 잠금 안에서 확인, 병합으로 넘칠 수 있음).
 * 해제는 revoked_at·revoked_by를 채우고 행은 남깁니다(같은 사람을 다시 지정하면 새 행). 권한은 해제되지 않은 행 + active 계정일 때만이라
 * 해제하는 순간 다음 요청부터 권한이 없습니다. show_in_portfolio는 본인만 켜고 끄며 기본 꺼짐(공개 프로필 "후배 기여"에 과목 이름 표시).
 * 과목 병합 때 정본으로 옮기고(같은 사람이 이미 있으면 원본 쪽을 해제), 탈퇴 정리 때 그 사람의 행을 지웁니다.
 */
export const courseCurators = pgTable(
  'course_curators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 지정한 운영자. */
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    showInPortfolio: boolean('show_in_portfolio').notNull().default(false),
  },
  (t) => [
    uniqueIndex('course_curators_open_key').on(t.courseId, t.userId).where(sql`${t.revokedAt} is null`),
    index('course_curators_user_id_idx').on(t.userId),
    check('course_curators_revoked_check', sql`${t.revokedAt} is not null or ${t.revokedBy} is null`),
  ],
)

/**
 * 과제 유형 요약(§8.6 "과제 유형 요약 정리"): 정본 과목마다 한 편, 큐레이터(또는 운영자)가 쓰는 짧은 글(1000자). 과목 허브(열린 허브)에 공개됩니다.
 * 작성자 이름은 허브에 싣지 않습니다. 고칠 때마다 version이 오르고 감사 `curator.summary_update`(과목 id·version만)가 남습니다(이전 글은 보관하지 않음).
 * 비우면 행을 지웁니다. 과목 병합 때 정본에 요약이 없으면 옮기고, 있으면 정본 것을 둡니다. 탈퇴 정리 때 updated_by만 비웁니다(글은 과목의 것).
 */
export const courseTypeSummaries = pgTable(
  'course_type_summaries',
  {
    courseId: uuid('course_id')
      .primaryKey()
      .references(() => courses.id),
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('course_type_summaries_body_check', sql`char_length(${t.body}) between 1 and 1000`),
    check('course_type_summaries_version_check', sql`${t.version} >= 1`),
  ],
)

/**
 * 큐레이터의 개념 태그 병합 제안. 원본 태그는 그 과목에 붙은 정본 태그, 대상은 아무 정본 태그. 운영자가 승인하면 기존 병합(ADR 0010)을 같은 트랜잭션에서
 * 실행하고, 거절하면 상태만 바꿉니다. 같은 (원본, 대상)의 대기 제안은 하나. 탈퇴 정리 때 proposed_by만 비웁니다(제안·결정 기록은 남김).
 */
export const conceptTagMergeProposals = pgTable(
  'concept_tag_merge_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    sourceTagId: uuid('source_tag_id')
      .notNull()
      .references(() => conceptTags.id),
    targetTagId: uuid('target_tag_id')
      .notNull()
      .references(() => conceptTags.id),
    proposedBy: uuid('proposed_by').references(() => users.id),
    /** 제안 이유(300자, 선택). 운영자와 같은 과목 큐레이터가 봅니다. */
    note: text('note'),
    status: conceptTagProposalStatus('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('concept_tag_merge_proposals_pending_key').on(t.sourceTagId, t.targetTagId).where(sql`${t.status} = 'pending'`),
    index('concept_tag_merge_proposals_course_idx').on(t.courseId),
    index('concept_tag_merge_proposals_status_idx').on(t.status, t.createdAt),
    check('concept_tag_merge_proposals_distinct_check', sql`${t.sourceTagId} <> ${t.targetTagId}`),
    check('concept_tag_merge_proposals_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 300`),
    check('concept_tag_merge_proposals_decided_check', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
  ],
)

/**
 * 큐레이터의 1차 신고 검토 의견(기각 권장·가리기 권장 + 짧은 메모). 신고 묶음(같은 target_key의 처리 전 신고)의 가장 오래된 신고(report_id)에 붙고,
 * 큐레이터마다 하나(다시 내면 고침). 운영자 신고 상세가 보여 주며 신고 상태·처리에는 영향이 없습니다. 탈퇴 정리 때 curator_id만 비웁니다.
 */
export const curatorReportRecommendations = pgTable(
  'curator_report_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id),
    targetKey: text('target_key').notNull(),
    /** 의견을 낼 때의 정본 과목. */
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    curatorId: uuid('curator_id').references(() => users.id),
    recommendation: curatorRecommendation('recommendation').notNull(),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('curator_report_recommendations_report_curator_key').on(t.reportId, t.curatorId),
    index('curator_report_recommendations_target_key_idx').on(t.targetKey),
    check('curator_report_recommendations_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 300`),
  ],
)

// ── 막힘 Q&A 스레드 (E-04, PROOFU_EVOLUTION_PLAN §8.5, DELIVERY_PLAN §4.4, ADR 0049) ─────────────

/**
 * 막힘 카드의 질문 허용(E-04). (공개, 스냅샷 로그 키)마다 하나 — 키는 공개마다 안정되므로 새 버전을 게시해도 같은 카드입니다.
 * - author_id: 켤 때 지금 release의 refs.logs[키].authorId(그 막힘 로그를 쓴 사람). 공개 응답에 싣지 않습니다. 읽기·쓰기는 요청마다 지금 release의
 *   refs로 로그 작성자를 다시 정하며(`작성자` 표시·허용 권한), 이 열은 기록용입니다.
 * - questions_allowed: 켜져 있을 때만 새 질문·답변을 받습니다. 끄면 기존 스레드는 읽기만 됩니다.
 * - **공개가 철회·제한·대체되어 그 카드가 지금 release에 없거나, 엠바고 중이거나, 로그가 운영 조치로 가려지면** 스레드는 읽기·쓰기 모두 404입니다
 *   (요청마다 loadServedRelease로 판정, 행을 지우거나 고치지 않음). 다시 게시되면 같은 카드로 돌아옵니다.
 * 과목 허브 구역의 테이블입니다(커뮤니티 테이블을 가리키지 않음, C-05).
 */
export const stuckQaCards = pgTable(
  'stuck_qa_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publications.id),
    itemKey: text('item_key').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    questionsAllowed: boolean('questions_allowed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('stuck_qa_cards_publication_item_key').on(t.publicationId, t.itemKey),
    check('stuck_qa_cards_item_key_check', sql`char_length(${t.itemKey}) between 1 and 40`),
  ],
)

/**
 * 질문 스레드(E-04). 질문 글(stuck_qa_posts kind = question) 하나로 열립니다. asker_id는 공개 응답에 싣지 않습니다(운영자 작성자 확인·탈퇴 정리용).
 * last_post_at: 마지막 게시 글 시각(카드 안 정렬의 두 번째 기준).
 */
export const stuckQaThreads = pgTable(
  'stuck_qa_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => stuckQaCards.id),
    askerId: uuid('asker_id').references(() => users.id),
    createdAt: createdAt(),
    lastPostAt: timestamp('last_post_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stuck_qa_threads_card_idx').on(t.cardId, t.lastPostAt.desc())],
)

/**
 * 스레드 익명 번호(E-04). 스레드·사람마다 번호 하나: 질문한 사람 0(`질문자`), 다른 사람은 그 스레드에 처음 쓴 순서대로 1, 2, …(`익명N`).
 * 막힘 로그 작성자는 행이 없습니다(항상 `작성자`). 지워도 번호를 다시 쓰지 않고(행을 지우지 않음), 스레드 사이에 번호를 공유하지 않습니다.
 * 이 행의 id·user_id는 어떤 응답에도 나가지 않습니다. 탈퇴 정리도 행을 남깁니다(스레드의 다른 번호가 바뀌지 않게).
 */
export const stuckQaAliases = pgTable(
  'stuck_qa_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => stuckQaThreads.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    aliasNo: integer('alias_no').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stuck_qa_aliases_thread_user_key').on(t.threadId, t.userId),
    uniqueIndex('stuck_qa_aliases_thread_alias_key').on(t.threadId, t.aliasNo),
    check('stuck_qa_aliases_alias_no_check', sql`${t.aliasNo} >= 0`),
  ],
)

/**
 * 질문·답변 글(E-04). 공개 응답은 표시(`질문자`·`익명N`·`작성자`)와 본문뿐이고 author_id는 싣지 않습니다(운영자는 신고에 묶인 작성자 확인으로만 앎).
 * - by_log_author: 쓸 때 막힘 로그 작성자였는지(그러면 alias_no 없음, 항상 `작성자`). 아니면 alias_no(stuck_qa_aliases와 같은 값).
 * - count_as_contribution: 답변자가 고른 포트폴리오 "후배 기여" 포함 여부(답변만, 기본 false — 익명 답변이 실명 프로필과 이어지지 않게).
 * - 상태: published / withdrawn(작성자가 지움·탈퇴 정리, 본문 '') / hidden(운영 조치). 질문 글이 published가 아니면 스레드 전체가 보이지 않습니다.
 */
export const stuckQaPosts = pgTable(
  'stuck_qa_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => stuckQaThreads.id),
    authorId: uuid('author_id').references(() => users.id),
    kind: stuckQaPostKind('kind').notNull(),
    byLogAuthor: boolean('by_log_author').notNull().default(false),
    aliasNo: integer('alias_no'),
    body: text('body').notNull(),
    countAsContribution: boolean('count_as_contribution').notNull().default(false),
    status: stuckQaPostStatus('status').notNull().default('published'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [
    index('stuck_qa_posts_thread_idx').on(t.threadId, t.createdAt),
    index('stuck_qa_posts_author_idx').on(t.authorId),
    // 스레드마다 질문은 하나.
    uniqueIndex('stuck_qa_posts_question_key').on(t.threadId).where(sql`${t.kind} = 'question'`),
    check('stuck_qa_posts_alias_check', sql`(${t.byLogAuthor} and ${t.aliasNo} is null) or (not ${t.byLogAuthor} and ${t.aliasNo} is not null and ${t.aliasNo} >= 0)`),
    check(
      'stuck_qa_posts_body_check',
      sql`(${t.status}::text = 'withdrawn' and ${t.body} = '') or (${t.status}::text <> 'withdrawn' and char_length(${t.body}) between 1 and 2000)`,
    ),
    check('stuck_qa_posts_withdrawn_check', sql`(${t.status}::text = 'withdrawn') = (${t.withdrawnAt} is not null)`),
    check('stuck_qa_posts_contribution_check', sql`${t.kind}::text = 'answer' or not ${t.countAsContribution}`),
  ],
)

/**
 * "도움됐어요"(E-04). 답변·사람마다 하나. **정렬에만** 씁니다: 개수·누가 눌렀는지는 어떤 응답에도 싣지 않고 작성자별로 합산하지 않습니다.
 * 탈퇴 정리 때 그 사람의 행을 지웁니다.
 */
export const stuckQaHelpful = pgTable(
  'stuck_qa_helpful',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => stuckQaPosts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stuck_qa_helpful_post_user_key').on(t.postId, t.userId), index('stuck_qa_helpful_user_idx').on(t.userId)],
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
 * 포트폴리오 판. 만들 때마다 새 version(페르소나마다 1부터)이고 만든 뒤 바꾸지 않습니다. 페르소나마다 지금 판(current)은 하나이며
 * 공개 프로필은 그 페르소나의 지금 판만 보여 줍니다(이전 판은 남지만 공개하지 않음). 채용자용 판의 기본은 real 페르소나입니다(S-01, ADR 0028).
 * - headline: 판의 한 줄 소개(없으면 프로필의 한 줄 소개). competencies: [{label, preset}] 행 순서. skills_declared: 자기 선언 스킬.
 */
export const portfolioEditions = pgTable(
  'portfolio_editions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 판이 귀속된 페르소나(S-01). (persona_id, user_id) 복합 외래 키로 주인이 같은지 DB가 확인합니다. */
    personaId: uuid('persona_id').notNull(),
    version: integer('version').notNull(),
    headline: text('headline'),
    competencies: jsonb('competencies').$type<Array<Record<string, unknown>>>().notNull().default([]),
    skillsDeclared: text('skills_declared').array().notNull().default(sql`'{}'::text[]`),
    /** current: 공개 프로필에 쓰는 판 / superseded: 새 판으로 바뀜. */
    status: text('status').notNull().default('current'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('portfolio_editions_persona_version_key').on(t.personaId, t.version),
    uniqueIndex('portfolio_editions_current_key').on(t.personaId).where(sql`${t.status} = 'current'`),
    index('portfolio_editions_user_id_idx').on(t.userId),
    foreignKey({ name: 'portfolio_editions_persona_user_fk', columns: [t.personaId, t.userId], foreignColumns: [personas.id, personas.userId] }),
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

/**
 * 면접 준비 팩 항목(E-06, PROOFU_EVOLUTION_PLAN §10.5, ADR 0050). 질문 자체는 저장하지 않고 읽을 때마다 케이스 문장의 인용에서 만듭니다
 * (@peerchive/domain `generateInterviewQuestions`). 이 행은 학생이 질문에 붙인 것만 담습니다: 비공개 답변 메모와 공개 선택(shown).
 * - (user_id, publication_id, question_key)마다 하나. 질문 키는 공개마다 안정된 스냅샷 로그 키로 만들므로, 케이스를 고치거나 새 공개 버전으로
 *   다시 만들어도 같은 질문의 메모가 이어집니다. 지금 만들어지지 않는 키의 행은 지우지 않고 본인에게만 "보관된 메모"로 보입니다.
 * - note는 **본인만** 읽습니다. 공개 DTO·검색·피드·인쇄·README 카드 어디에도 싣지 않습니다.
 * - shown은 질문 글만 공개한다는 선택입니다. 공개 프로필은 그 케이스가 지금 볼 수 있고(게시 중·release 제공 가능·숨김 아님) 실명 페르소나의
 *   대표 케이스이며 그 질문이 지금 만들어질 때만 보여 줍니다.
 * - question_text는 마지막으로 저장할 때의 질문 글(보관된 메모를 알아보고, 질문 글이 바뀌었는지 알리는 데만 씀).
 * 탈퇴 정리 때 그 사람의 행을 모두 지웁니다.
 */
export const interviewPrepEntries = pgTable(
  'interview_prep_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publications.id),
    questionKey: text('question_key').notNull(),
    questionText: text('question_text').notNull(),
    note: text('note'),
    shown: boolean('shown').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('interview_prep_entries_key').on(t.userId, t.publicationId, t.questionKey),
    index('interview_prep_entries_publication_idx').on(t.publicationId),
    check('interview_prep_entries_key_check', sql`char_length(${t.questionKey}) between 1 and 100`),
    check('interview_prep_entries_text_check', sql`char_length(${t.questionText}) between 1 and 400`),
    check('interview_prep_entries_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 2000`),
    check('interview_prep_entries_nonempty_check', sql`${t.note} is not null or ${t.shown}`),
  ],
)

/**
 * 포트폴리오 판 제한 공유 링크(E-07, SYSTEM_DESIGN §6.5 ShareGrant·§8 restricted-share, ADR 0051).
 * - 판 하나를 가리키는 bearer 토큰. **원문 토큰은 저장하지 않고** SHA-256 hex만 둡니다(만든 응답에서 한 번만 원문을 돌려줌).
 * - 만료(최대 90일)·철회(revoked_at)·열람 횟수(view_count)만 기록합니다. 보는 사람의 IP·브라우저·시각은 남기지 않습니다.
 * - 공유 페이지는 요청마다 판·페르소나·케이스 공개 상태를 다시 판정하므로 이 행이 공개 범위를 넓히지 않습니다.
 * 탈퇴 정리 때 그 사람의 행을 판보다 먼저 지웁니다.
 */
export const portfolioShareLinks = pgTable(
  'portfolio_share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => portfolioEditions.id),
    tokenHash: text('token_hash').notNull(),
    label: text('label'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('portfolio_share_links_token_hash_key').on(t.tokenHash),
    index('portfolio_share_links_user_id_idx').on(t.userId),
    index('portfolio_share_links_edition_id_idx').on(t.editionId),
    check('portfolio_share_links_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('portfolio_share_links_label_check', sql`${t.label} is null or char_length(${t.label}) between 1 and 60`),
    check('portfolio_share_links_view_count_check', sql`${t.viewCount} >= 0`),
    check('portfolio_share_links_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
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
    /** 커뮤니티 공간 조치(restrict_space, C-02 / 운영자 직접 보관 archive_space). */
    communitySpaceId: uuid('community_space_id').references((): AnyPgColumn => communitySpaces.id),
    /** 커뮤니티 글·댓글 가리기(hide_post·hide_comment, C-04). */
    communityPostId: uuid('community_post_id').references((): AnyPgColumn => communityPosts.id),
    communityCommentId: uuid('community_comment_id').references((): AnyPgColumn => communityComments.id),
    /** 모집 글·지원 메시지 가리기(hide_recruitment·hide_application, C-07). */
    communityRecruitmentId: uuid('community_recruitment_id').references((): AnyPgColumn => recruitments.id),
    communityApplicationId: uuid('community_application_id').references((): AnyPgColumn => recruitmentApplications.id),
    /** 막힘 Q&A 숨기기(hide_qa, C-09). */
    courseQaItemId: uuid('course_qa_item_id').references((): AnyPgColumn => courseQaItems.id),
    /**
     * S-07(ADR 0036): 페르소나·프로필 글·소셜 링크 조치. **외래 키가 없습니다**: 탈퇴 정리가 그 사람만의 자료(페르소나·글·링크)를 지우고, 조치 기록은
     * 남아 지워진 대상을 가리킵니다(운영 화면은 "찾을 수 없음"). 주인 사용자 id는 두지 않습니다(표시명 조치가 사용자로 이어지지 않게).
     */
    personaId: uuid('persona_id'),
    profilePostId: uuid('profile_post_id'),
    socialLinkId: uuid('social_link_id'),
    /** 수료 회고 숨기기(hide_retro, A-06). */
    completionRetroId: uuid('completion_retro_id').references((): AnyPgColumn => completionRetros.id),
    /**
     * A-07(ADR 0045): 방 항목 숨기기(hide_room_item). 종류 + 그 행의 id. **외래 키가 없습니다**(명부 철회·방 나가기·탈퇴 정리가 행을 지워도 조치 기록은
     * 남음). 주인 사용자 id는 두지 않습니다.
     */
    roomItemKind: roomItemKind('room_item_kind'),
    roomItemId: uuid('room_item_id'),
    /** E-04(ADR 0049): 막힘 Q&A 글 숨기기(hide_stuck_qa_post). */
    stuckQaPostId: uuid('stuck_qa_post_id').references((): AnyPgColumn => stuckQaPosts.id),
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
    /** lift(운영자 제한 해제·제재 해제) / appeal(이의제기 되돌림) / space(방 운영진이 자기 가리기를 되돌림, C-06). */
    reverseCause: text('reverse_cause'),
  },
  (t) => [
    index('moderation_actions_target_key_idx').on(t.targetKey, t.createdAt),
    index('moderation_actions_publication_idx').on(t.publicationId),
    index('moderation_actions_senior_note_idx').on(t.seniorNoteId),
    index('moderation_actions_case_study_idx').on(t.caseStudyId),
    index('moderation_actions_profile_user_idx').on(t.profileUserId),
    index('moderation_actions_community_space_idx').on(t.communitySpaceId),
    index('moderation_actions_community_post_idx').on(t.communityPostId),
    index('moderation_actions_community_comment_idx').on(t.communityCommentId),
    index('moderation_actions_community_recruitment_idx').on(t.communityRecruitmentId),
    index('moderation_actions_community_application_idx').on(t.communityApplicationId),
    index('moderation_actions_course_qa_idx').on(t.courseQaItemId),
    index('moderation_actions_persona_idx').on(t.personaId),
    index('moderation_actions_profile_post_idx').on(t.profilePostId),
    index('moderation_actions_social_link_idx').on(t.socialLinkId),
    index('moderation_actions_completion_retro_idx').on(t.completionRetroId),
    index('moderation_actions_room_item_idx').on(t.roomItemId),
    index('moderation_actions_stuck_qa_post_idx').on(t.stuckQaPostId),
    check('moderation_actions_outcome_check', sql`${t.outcome} in ('resolved', 'dismissed') and (${t.outcome} = 'resolved' or ${t.kind} = 'none')`),
    check('moderation_actions_internal_note_check', sql`char_length(${t.internalNote}) between 1 and 1000`),
    check('moderation_actions_public_reason_check', sql`${t.publicReason} is null or char_length(${t.publicReason}) between 1 and 300`),
    check('moderation_actions_reverse_note_check', sql`${t.reverseNote} is null or char_length(${t.reverseNote}) between 1 and 1000`),
    check(
      'moderation_actions_reversed_check',
      sql`(${t.reversedAt} is null) = (${t.reverseCause} is null) and (${t.reverseCause} is null or ${t.reverseCause} in ('lift', 'appeal', 'space')) and (${t.reversedAt} is null or ${t.kind} <> 'none')`,
    ),
    // ::text 비교: 같은 migration에서 더한 enum 값을 리터럴로 쓰면 PostgreSQL이 "unsafe use of new value"로 거부합니다.
    check('moderation_actions_space_check', sql`${t.kind}::text not in ('restrict_space', 'archive_space') or ${t.communitySpaceId} is not null`),
    check('moderation_actions_post_check', sql`${t.kind}::text <> 'hide_post' or ${t.communityPostId} is not null`),
    check('moderation_actions_comment_check', sql`${t.kind}::text <> 'hide_comment' or ${t.communityCommentId} is not null`),
    check('moderation_actions_recruitment_check', sql`${t.kind}::text <> 'hide_recruitment' or ${t.communityRecruitmentId} is not null`),
    check('moderation_actions_application_check', sql`${t.kind}::text <> 'hide_application' or ${t.communityApplicationId} is not null`),
    check('moderation_actions_course_qa_check', sql`${t.kind}::text <> 'hide_qa' or ${t.courseQaItemId} is not null`),
    check('moderation_actions_persona_check', sql`${t.kind}::text <> 'hide_persona' or ${t.personaId} is not null`),
    check('moderation_actions_profile_post_check', sql`${t.kind}::text <> 'hide_profile_post' or ${t.profilePostId} is not null`),
    check('moderation_actions_social_link_check', sql`${t.kind}::text <> 'hide_social_link' or ${t.socialLinkId} is not null`),
    check('moderation_actions_completion_retro_check', sql`${t.kind}::text <> 'hide_retro' or ${t.completionRetroId} is not null`),
    check('moderation_actions_room_item_check', sql`${t.kind}::text <> 'hide_room_item' or (${t.roomItemKind} is not null and ${t.roomItemId} is not null)`),
    check('moderation_actions_stuck_qa_post_check', sql`${t.kind}::text <> 'hide_stuck_qa_post' or ${t.stuckQaPostId} is not null`),
    // C-06: 방 운영진 가리기·제재는 글 또는 댓글 하나를 가리키고 공간 id는 비웁니다(방장이 당사자가 되지 않게, ADR 0023).
    check(
      'moderation_actions_community_item_check',
      sql`${t.kind}::text not in ('space_hide', 'sanction') or ((${t.communityPostId} is null) <> (${t.communityCommentId} is null) and ${t.communitySpaceId} is null)`,
    ),
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
    /** 신고한 커뮤니티 글·댓글(C-04). 내용은 복사하지 않습니다(운영자는 지금 행을 봄). */
    communityPostId: uuid('community_post_id').references((): AnyPgColumn => communityPosts.id),
    communityCommentId: uuid('community_comment_id').references((): AnyPgColumn => communityComments.id),
    /** 신고한 모집 글·지원 메시지(C-07). 지원 메시지는 그 모집의 모집자만 신고합니다. 내용은 복사하지 않습니다. */
    communityRecruitmentId: uuid('community_recruitment_id').references((): AnyPgColumn => recruitments.id),
    communityApplicationId: uuid('community_application_id').references((): AnyPgColumn => recruitmentApplications.id),
    /** 신고한 막힘 Q&A(C-09). 내용은 복사하지 않습니다. */
    courseQaItemId: uuid('course_qa_item_id').references((): AnyPgColumn => courseQaItems.id),
    /**
     * 신고한 페르소나·프로필 글·소셜 링크(S-07, ADR 0036). 포인터만(내용 복사 없음), 외래 키 없음(탈퇴 정리가 대상을 지워도 신고 기록은 남음).
     * 프로필 글·링크 신고에도 그 페르소나 id를 함께 두지 않습니다(대상 하나만 가리킴).
     */
    personaId: uuid('persona_id'),
    profilePostId: uuid('profile_post_id'),
    socialLinkId: uuid('social_link_id'),
    /** 신고한 수료 회고(A-06). 내용은 복사하지 않습니다. */
    completionRetroId: uuid('completion_retro_id').references((): AnyPgColumn => completionRetros.id),
    /** 신고한 방 항목(A-07, ADR 0045). 종류 + 그 행의 id, 외래 키 없음(행이 지워져도 신고 기록은 남음), 내용 복사 없음, 주인 사용자 id 없음. */
    roomItemKind: roomItemKind('room_item_kind'),
    roomItemId: uuid('room_item_id'),
    /** 신고한 막힘 Q&A 글(E-04, ADR 0049). 내용은 복사하지 않습니다(운영자는 지금 행을 봄). */
    stuckQaPostId: uuid('stuck_qa_post_id').references((): AnyPgColumn => stuckQaPosts.id),
    reason: reportReason('reason').notNull(),
    details: text('details'),
    status: reportStatus('status').notNull().default('open'),
    assignedTo: uuid('assigned_to').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    actionId: uuid('action_id').references(() => moderationActions.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * 운영자의 첫 처리(담당 배정 또는 처리·기각) 시각(C-10, ADR 0027). 다시 배정해도 바꾸지 않습니다(assigned_at은 마지막 배정).
     * 처리 시간 지표·SLA의 "첫 조치까지 시간"이 씁니다.
     */
    firstActionAt: timestamp('first_action_at', { withTimezone: true }),
    /**
     * 신고 누적으로 대상 글·댓글이 임시 숨김된 시각(C-06 → C-10, ADR 0027). 숨김을 일으킨 트랜잭션이 그때 처리 전이던 같은 대상의 신고에 채웁니다.
     * 우선 검토 SLA(기본 24시간)의 시작점이자 "자동 숨김 후 검토 완료까지 시간"의 시작점입니다. 커뮤니티 테이블을 읽지 않고도 운영 지표·상태 확인이 씁니다.
     */
    autoHiddenAt: timestamp('auto_hidden_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reports_open_reporter_target_key')
      .on(t.reporterId, t.targetKey)
      .where(sql`${t.status} in ('open', 'in_review')`),
    index('reports_target_key_idx').on(t.targetKey, t.status),
    index('reports_status_created_idx').on(t.status, t.createdAt),
    index('reports_closed_at_idx').on(t.closedAt),
    index('reports_reporter_idx').on(t.reporterId, t.createdAt),
    index('reports_completion_retro_idx').on(t.completionRetroId),
    index('reports_room_item_idx').on(t.roomItemId),
    index('reports_stuck_qa_post_idx').on(t.stuckQaPostId),
    check('reports_details_check', sql`${t.details} is null or char_length(${t.details}) between 1 and 1000`),
    check('reports_first_action_check', sql`${t.firstActionAt} is null or ${t.firstActionAt} >= ${t.createdAt}`),
    check('reports_closed_check', sql`(${t.status} in ('resolved', 'dismissed')) = (${t.closedAt} is not null and ${t.actionId} is not null)`),
    check('reports_item_key_check', sql`${t.itemKey} is null or char_length(${t.itemKey}) between 1 and 64`),
    check(
      'reports_target_check',
      sql`(${t.targetType} = 'publication' and ${t.publicationId} is not null and ${t.releaseId} is not null and ${t.itemKind} is null)
        or (${t.targetType} = 'publication_item' and ${t.publicationId} is not null and ${t.releaseId} is not null and ${t.itemKind} is not null and ${t.itemKey} is not null)
        or (${t.targetType} = 'senior_note' and ${t.seniorNoteId} is not null and ${t.noteVersion} is not null)
        or (${t.targetType} = 'case_study' and ${t.caseStudyId} is not null and ${t.caseStudyVersion} is not null)
        or (${t.targetType} = 'profile' and ${t.profileUserId} is not null)
        or (${t.targetType}::text = 'community_space' and ${t.communitySpaceId} is not null)
        or (${t.targetType}::text = 'community_post' and ${t.communityPostId} is not null)
        or (${t.targetType}::text = 'community_comment' and ${t.communityCommentId} is not null)
        or (${t.targetType}::text = 'community_recruitment' and ${t.communityRecruitmentId} is not null)
        or (${t.targetType}::text = 'community_application' and ${t.communityApplicationId} is not null)
        or (${t.targetType}::text = 'course_qa' and ${t.courseQaItemId} is not null)
        or (${t.targetType}::text = 'persona' and ${t.personaId} is not null)
        or (${t.targetType}::text = 'profile_post' and ${t.profilePostId} is not null)
        or (${t.targetType}::text = 'social_link' and ${t.socialLinkId} is not null)
        or (${t.targetType}::text = 'completion_retro' and ${t.completionRetroId} is not null)
        or (${t.targetType}::text = 'room_item' and ${t.roomItemKind} is not null and ${t.roomItemId} is not null)
        or (${t.targetType}::text = 'stuck_qa_post' and ${t.stuckQaPostId} is not null)`,
    ),
    // 표시명 사칭은 프로필 신고에만(@peerchive/domain reasonApplicable).
    check('reports_impersonation_check', sql`${t.reason}::text <> 'impersonation' or ${t.targetType}::text in ('persona', 'profile')`),
    // 소속·기수 사칭(A-07)은 커뮤니티 글·댓글·수료 회고·방 항목(명부 항목·방별 프로필)에만.
    check(
      'reports_affiliation_impersonation_check',
      sql`${t.reason}::text <> 'affiliation_impersonation' or ${t.targetType}::text in ('community_post', 'community_comment', 'completion_retro')
        or (${t.targetType}::text = 'room_item' and ${t.roomItemKind}::text in ('directory_entry', 'room_profile'))`,
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

/**
 * 운영자의 페르소나 주인 확인 기록(S-07, ADR 0036, SYSTEM_DESIGN §8.3 표 "표시명 ↔ 실명 연결 보기 — 운영자: 신고 처리 시 감사 기록과 함께").
 * 운영자 화면은 신고된 페르소나 자신의 handle·이름·내용만 보여 주고, 그 페르소나가 누구의 것인지(같은 사람의 다른 페르소나·계정)는 이 확인으로만 엽니다.
 * - 페르소나·프로필 글·소셜 링크 신고(report_id 필수, 그 신고의 대상 페르소나)에만, 사유(1~1000자) 필수. 사유는 **여기에만** 남고 감사에는 id만.
 * - owner_user_id: 확인된 주인. 탈퇴 정리 때 비웁니다(확인했다는 접근 기록은 남김, community_author_lookups와 같은 규칙).
 * - persona_id는 외래 키가 없습니다(탈퇴 정리가 페르소나를 지워도 접근 기록은 남음).
 */
export const personaOwnerLookups = pgTable(
  'persona_owner_lookups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => users.id),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id),
    personaId: uuid('persona_id').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('persona_owner_lookups_report_idx').on(t.reportId),
    index('persona_owner_lookups_created_idx').on(t.createdAt),
    check('persona_owner_lookups_reason_check', sql`char_length(${t.reason}) between 1 and 1000`),
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
    /**
     * purge: 유예 기간 뒤 정리 / reapply: 복구 뒤 재적용 / retention: 보존 기간이 끝난 개별 자료(I-01 수료증 파일 — subject_hash는 사용자 id가
     * 아니라 수료증 확인 id의 HMAC이고, 재적용은 계정이 아니라 그 파일만 다시 지움).
     */
    source: text('source').notNull().default('purge'),
  },
  (t) => [
    index('deletion_ledger_subject_hash_idx').on(t.subjectHash),
    check('deletion_ledger_subject_hash_check', sql`${t.subjectHash} ~ '^[0-9a-f]{64}$'`),
    check('deletion_ledger_entity_kind_check', sql`${t.entityKind} ~ '^[a-z_]{1,40}$'`),
    check('deletion_ledger_count_check', sql`${t.count} >= 0`),
    check('deletion_ledger_source_check', sql`${t.source} in ('purge', 'reapply', 'retention')`),
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
    /**
     * HMAC(분석 pepper, 사용자 id). **null = 사용자 키 없음**(C-10, ADR 0027): 익명 글·댓글·익명 대상 공감, 신고·임시 숨김·제재·작성자 확인,
     * 아카이브로 옮기기 이벤트(DELIVERY_PLAN §6.1 "익명 글·댓글 이벤트에는 사용자 키를 붙이지 않음"). 사람 단위 지표(주간 활성 등)는 키 있는 이벤트만 셉니다.
     */
    actorHash: text('actor_hash'),
    projectHash: text('project_hash'),
    hashKeyId: text('hash_key_id').notNull(),
    props: jsonb('props').$type<Record<string, string | number | boolean>>().notNull().default({}),
  },
  (t) => [
    index('analytics_events_name_occurred_idx').on(t.name, t.occurredAt),
    index('analytics_events_actor_occurred_idx').on(t.actorHash, t.occurredAt),
    check('analytics_events_actor_hash_check', sql`${t.actorHash} is null or ${t.actorHash} ~ '^[0-9a-f]{64}$'`),
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

/**
 * 운영자 주간 운영 시간 기록(C-10, DELIVERY_PLAN §4.1 C-10·§6.1 "운영 부담"·§7 GC "주간 시간", ADR 0027).
 * 운영자마다 서울 ISO 주(`YYYY-Www`) 하나에 한 행. 분야별 분(신고 검토·공식 페이지·학교 인증 지원·큐레이션·기타)과 선택 메모(200자, 본인만 봄).
 * 지표에는 주·분야별 합계만 나가고(사람별 순위 없음), 사람별 행은 본인에게만 보입니다. 탈퇴 정리는 메모만 지우고 분은 남깁니다(가명 사용자 행을 가리킴).
 */
export const opsTimeEntries = pgTable(
  'ops_time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => users.id),
    week: text('week').notNull(),
    reportsMinutes: integer('reports_minutes').notNull().default(0),
    officialPagesMinutes: integer('official_pages_minutes').notNull().default(0),
    affiliationSupportMinutes: integer('affiliation_support_minutes').notNull().default(0),
    curationMinutes: integer('curation_minutes').notNull().default(0),
    otherMinutes: integer('other_minutes').notNull().default(0),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ops_time_entries_operator_week_key').on(t.operatorId, t.week),
    index('ops_time_entries_week_idx').on(t.week),
    check('ops_time_entries_week_check', sql`${t.week} ~ '^[0-9]{4}-W[0-9]{2}$'`),
    check(
      'ops_time_entries_minutes_check',
      sql`${t.reportsMinutes} >= 0 and ${t.officialPagesMinutes} >= 0 and ${t.affiliationSupportMinutes} >= 0 and ${t.curationMinutes} >= 0 and ${t.otherMinutes} >= 0
        and ${t.reportsMinutes} + ${t.officialPagesMinutes} + ${t.affiliationSupportMinutes} + ${t.curationMinutes} + ${t.otherMinutes} <= 10080`,
    ),
    check('ops_time_entries_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 200`),
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
    /** 정규화한 학교 메일 주소의 HMAC(hex 64). 메일 인증(method email)의 pending·active일 때만 있고 해제·취소·만료되면 null. */
    emailHash: text('email_hash'),
    /** 메일 도메인(소문자 ASCII). 본인·운영자에게만 보입니다. 메일이 아닌 수단(I-01)이면 null. */
    emailDomain: text('email_domain'),
    /** 기수(I-01). 기수 승인은 필수, 초대 코드는 코드의 기수, 수료증은 선택. 대학은 쓰지 않습니다. */
    cohortId: uuid('cohort_id').references((): AnyPgColumn => institutionCohorts.id),
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
    index('institution_affiliations_cohort_id_idx').on(t.cohortId),
    check('institution_affiliations_email_hash_check', sql`${t.emailHash} is null or ${t.emailHash} ~ '^[0-9a-f]{64}$'`),
    // enum 값은 같은 migration에서 더했으므로 text로 비교합니다(ALTER TYPE … ADD VALUE는 같은 트랜잭션에서 쓸 수 없음).
    check(
      'institution_affiliations_open_hash_check',
      sql`${t.method}::text <> 'email' or ${t.status} not in ('pending', 'active') or ${t.emailHash} is not null`,
    ),
    check('institution_affiliations_email_method_check', sql`${t.method}::text = 'email' or ${t.emailHash} is null`),
    check('institution_affiliations_email_domain_required_check', sql`${t.method}::text <> 'email' or ${t.emailDomain} is not null`),
    check('institution_affiliations_cohort_required_check', sql`${t.method}::text <> 'cohort_approval' or ${t.cohortId} is not null`),
    check('institution_affiliations_active_verified_check', sql`${t.status} <> 'active' or ${t.verifiedAt} is not null`),
    check('institution_affiliations_revoked_check', sql`${t.status} <> 'revoked' or (${t.revokedAt} is not null and ${t.revokedReason} is not null)`),
    check(
      'institution_affiliations_department_label_check',
      sql`${t.departmentLabel} is null or char_length(${t.departmentLabel}) between 1 and 40`,
    ),
    check('institution_affiliations_email_domain_check', sql`${t.emailDomain} is null or char_length(${t.emailDomain}) between 3 and 253`),
    check(
      'institution_affiliations_revoked_reason_check',
      sql`${t.revokedReason} is null or ${t.revokedReason} in ('user_removed', 'operator', 'merged_duplicate', 'certificate_rejected')`,
    ),
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

// ── 기관 일반화·인증 수단 (I-01, PROOFU_EVOLUTION_PLAN §8.9.11, SYSTEM_DESIGN §6.7.2·§8.4, ADR 0037) ─────────────
//
// 대학이 아닌 기관(schools.kind)의 인증 수단: 초대 코드·기수 승인·수료증 확인. P2 기능 플래그(PEERCHIVE_FEATURE_P2_INSTITUTIONS)가 꺼져 있으면
// 웹의 새 경로는 404입니다. 수료증 파일 삭제(worker `certificate-files`)는 플래그와 무관하게 돕니다.

/**
 * 기수(부트캠프·교육 프로그램·동아리 기수, 예: `12기`). 대학에서는 쓰지 않습니다(학번 미수집 원칙). label_key는 같은 기수 판정용
 * (소문자·공백 제거, @peerchive/domain normalizeCohortLabel). 기관의 정본 행을 가리킵니다(대학이 아닌 기관은 병합하지 않음).
 */
export const institutionCohorts = pgTable(
  'institution_cohorts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    label: text('label').notNull(),
    labelKey: text('label_key').notNull(),
    /** 처음 만든 사람(기수 승인·수료증 요청을 낸 사용자 또는 코드를 발급한 운영자). CLI면 null. */
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('institution_cohorts_school_label_key').on(t.schoolId, t.labelKey),
    check('institution_cohorts_label_check', sql`char_length(${t.label}) between 1 and 20`),
    check('institution_cohorts_label_key_check', sql`char_length(${t.labelKey}) between 1 and 20`),
  ],
)

/**
 * 기관 초대 코드. **원문은 저장하지 않습니다**: HMAC-SHA256(PEERCHIVE_AFFILIATION_PEPPER, `invite-code:v1:` + 정규 코드)만 두고, 원문은 발급
 * 응답(API·CLI)에 한 번만 보입니다. 만료·사용 한도·철회. 사용하면 그 기관(과 기수)의 active 소속(method invite_code)이 생깁니다.
 */
export const institutionInviteCodes = pgTable(
  'institution_invite_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    cohortId: uuid('cohort_id').references(() => institutionCohorts.id),
    codeHash: text('code_hash').notNull(),
    /** 발급한 운영자(I-02부터 기관 운영진). CLI면 null. */
    issuedBy: uuid('issued_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses').notNull(),
    usedCount: integer('used_count').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('institution_invite_codes_code_hash_key').on(t.codeHash),
    index('institution_invite_codes_school_id_idx').on(t.schoolId),
    check('institution_invite_codes_code_hash_check', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check('institution_invite_codes_max_uses_check', sql`${t.maxUses} between 1 and 1000`),
    check('institution_invite_codes_used_count_check', sql`${t.usedCount} >= 0 and ${t.usedCount} <= ${t.maxUses}`),
  ],
)

/**
 * 기수 승인(SYSTEM_DESIGN §6.7.2 CohortApproval). 같은 기수에서 **기수 승인이 아닌 수단으로 인증된** 멤버의 승인 한 건.
 * 한 요청에 한 사람은 한 번만(기본 키). 승인할 때의 승인자 소속 행(approver_affiliation_id)을 남겨 나중에 그 인증이 사칭으로 판정되면 찾을 수 있게 합니다.
 */
export const cohortApprovals = pgTable(
  'cohort_approvals',
  {
    affiliationId: uuid('affiliation_id')
      .notNull()
      .references(() => institutionAffiliations.id),
    approverUserId: uuid('approver_user_id')
      .notNull()
      .references(() => users.id),
    approverAffiliationId: uuid('approver_affiliation_id')
      .notNull()
      .references(() => institutionAffiliations.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.affiliationId, t.approverUserId] }),
    index('cohort_approvals_approver_user_id_idx').on(t.approverUserId),
    index('cohort_approvals_approver_affiliation_id_idx').on(t.approverAffiliationId),
  ],
)

/**
 * 수료증 확인(SYSTEM_DESIGN §6.7.2 CertificateCheck). 소속 요청(method certificate_check) 하나에 하나.
 *
 * - 파일은 격리 키(`quarantine/<uuid>`)에만 둡니다. 검사(형식 판별·내장 콘텐츠·악성코드)를 통과하면 메타데이터를 지운 내용으로 같은 격리 키를
 *   바꿔 씁니다(clean 키로 옮기지 않음). 원래 파일 이름·OCR 텍스트·수료증 번호는 저장하지 않습니다(확장자만).
 * - 운영자는 결정 전·검사 통과일 때만 60초 서명 URL로 봅니다. 결정(approved/rejected) 시각을 남기고(A-07 처리 시간), worker가 결정 뒤
 *   파일을 지운 다음 object_key를 비우고 file_purged_at과 삭제 장부(source retention)를 남깁니다.
 */
export const certificateChecks = pgTable(
  'certificate_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    affiliationId: uuid('affiliation_id')
      .notNull()
      .references(() => institutionAffiliations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 격리 키. 파일을 지우면 null. */
    objectKey: text('object_key'),
    declaredType: text('declared_type').notNull(),
    /** 선언 형식에 맞는 확장자(검사의 확장자 대조용). 원래 파일 이름은 저장하지 않습니다. */
    fileExtension: text('file_extension').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    scanStatus: scanStatus('scan_status').notNull().default('pending'),
    scanReason: text('scan_reason'),
    scanEngine: text('scan_engine'),
    scanAttempts: integer('scan_attempts').notNull().default(0),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    /** 판별한 형식(검사 통과 뒤). */
    mediaType: text('media_type'),
    /** approved / rejected. */
    result: text('result'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    filePurgedAt: timestamp('file_purged_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('certificate_checks_affiliation_id_key').on(t.affiliationId),
    uniqueIndex('certificate_checks_object_key_key').on(t.objectKey),
    index('certificate_checks_user_id_idx').on(t.userId),
    index('certificate_checks_open_idx').on(t.createdAt).where(sql`${t.filePurgedAt} is null`),
    check('certificate_checks_result_check', sql`${t.result} is null or ${t.result} in ('approved', 'rejected')`),
    check('certificate_checks_decided_check', sql`(${t.result} is null) = (${t.decidedAt} is null)`),
    check('certificate_checks_purged_check', sql`${t.filePurgedAt} is null or ${t.objectKey} is null`),
    check('certificate_checks_object_key_check', sql`${t.objectKey} is null or ${t.objectKey} ~ '^quarantine/[0-9a-f-]{36}$'`),
    check('certificate_checks_extension_check', sql`${t.fileExtension} in ('png', 'jpg', 'jpeg', 'webp', 'pdf')`),
    check('certificate_checks_byte_size_check', sql`${t.byteSize} between 1 and 10485760`),
    check('certificate_checks_sha256_check', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
)

// ── 기관 운영진 (I-02, PROOFU_EVOLUTION_PLAN §8.9.11, SYSTEM_DESIGN §6.7.2 InstitutionAdmin·§8.4, ADR 0044) ─────────────
//
// 기관 운영진은 운영자만 지정·해제합니다(감사 id만). 권한은 자기 기관의 기관 페이지·기수 방에서 모더레이터 범위 + 설정·게시판 관리,
// 자기 기관의 초대 코드 발급·철회뿐입니다. 작성자 확인·수료증 확인·기관 단위 사용자 조회는 없습니다.

/**
 * 기관 운영진 지정(SYSTEM_DESIGN §6.7.2 InstitutionAdmin). 대학이 아닌 정본 기관에만 둡니다(서버 판정). 해제하면 revoked_at·revoked_by를 남기고
 * 행은 지우지 않습니다(누가 언제 운영진이었는지는 운영 기록). 탈퇴 정리는 그 사람의 행을 지웁니다.
 */
export const institutionStaff = pgTable(
  'institution_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 지정한 운영자. */
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('institution_staff_open_key').on(t.schoolId, t.userId).where(sql`${t.revokedAt} is null`),
    index('institution_staff_user_id_idx').on(t.userId),
    check('institution_staff_revoked_check', sql`${t.revokedAt} is not null or ${t.revokedBy} is null`),
  ],
)

// ── 수료 회고 (A-06, PROOFU_EVOLUTION_PLAN §8.9.10 "가져오지 않는 것"·§8.9.11, SYSTEM_DESIGN §6.7.2 "수료 회고", ADR 0043) ─────────────
//
// 부트캠프·교육 프로그램·동아리 연합 수료생이 그 기관(과 기수)에 남기는 구조화된 회고입니다. 선배 노트 형식(질문별 답)이고 **별점·연봉·추천 점수 열이
// 없습니다**(완료 기준 — 스키마 테스트가 열 이름을 확인). 커뮤니티 구역이 아니며(커뮤니티 테이블을 가리키지 않음) 페르소나로 투영하지 않습니다.
// P2 `institutions` 플래그가 꺼지면 웹 경로는 404입니다.

/**
 * 수료 회고 한 편. 쓰는 순간 게시되고(published), 작성자가 철회(withdrawn)하거나 운영자가 숨깁니다(hidden, 신고 → hide_retro).
 * - institution_id: 정본 기관(대학이 아닌 기관 — 대학이 아닌 기관은 병합하지 않음, ADR 0037). cohort_id: 작성자 소속의 기수(있으면).
 *   author_id: 철회·운영 안내·탈퇴 정리에만 쓰고 응답에 싣지 않습니다.
 * - 이름: display_mode(name/display/anonymous) + display_name_snapshot(쓰는 순간의 계정 이름·표시명 페르소나 이름, 익명이면 null).
 * - **기관 표시는 쓰는 순간 고정**(A-05 규칙, ADR 0042): 익명 회고는 작성자가 고른 범위(label_scope_requested)와 그 순간의 (정본 기관, 수료생)·
 *   (기관 종류, 수료생) 인증 회원 수로 정한 범위(label_scope_applied)·문자열(institution_label)을 남깁니다. 범위가 기관이 아니면 기관 목록에 나오지
 *   않고(기관 이름이 익명을 깨뜨리지 않게) 문자열만 보입니다. 이름을 건 회고는 언제나 기관 범위입니다(check).
 * - cohort_label: 이름을 건 회고에서 작성자가 고른 경우만(익명 회고는 기수를 보이지 않음, check). 쓰는 순간의 기수 글자.
 * - answers: {learned, curriculum, beforeStart, advice}(@peerchive/domain COMPLETION_RETRO_QUESTIONS) 각 1000자, 2개 이상.
 */
export const completionRetros = pgTable(
  'completion_retros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => schools.id),
    cohortId: uuid('cohort_id').references(() => institutionCohorts.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    displayMode: completionRetroDisplayMode('display_mode').notNull(),
    displayNameSnapshot: text('display_name_snapshot'),
    labelScopeRequested: affiliationLabelScope('label_scope_requested').notNull(),
    labelScopeApplied: affiliationLabelScope('label_scope_applied').notNull(),
    institutionLabel: text('institution_label'),
    cohortLabel: text('cohort_label'),
    answers: jsonb('answers').$type<Record<string, string>>().notNull(),
    /** "강사·운영진 개인 평가, 별점·연봉·추천 점수, 다른 수강생의 개인정보가 없습니다" 확인(필수). */
    guidelinesConfirmed: boolean('guidelines_confirmed').notNull(),
    status: completionRetroStatus('status').notNull().default('published'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('completion_retros_institution_published_idx').on(t.institutionId, t.publishedAt.desc()).where(sql`${t.status} = 'published'`),
    index('completion_retros_published_idx').on(t.publishedAt.desc()).where(sql`${t.status} = 'published'`),
    index('completion_retros_author_idx').on(t.authorId),
    index('completion_retros_cohort_idx').on(t.cohortId),
    // 사람·기관마다 공개(또는 숨김) 회고는 하나. 철회하면 새로 쓸 수 있습니다.
    uniqueIndex('completion_retros_author_institution_open_key').on(t.authorId, t.institutionId).where(sql`${t.status} in ('published', 'hidden')`),
    check('completion_retros_answers_object_check', sql`jsonb_typeof(${t.answers}) = 'object'`),
    check('completion_retros_confirmed_check', sql`${t.guidelinesConfirmed}`),
    check(
      'completion_retros_display_name_check',
      sql`(${t.displayMode} = 'anonymous') = (${t.displayNameSnapshot} is null)
        and (${t.displayNameSnapshot} is null or char_length(${t.displayNameSnapshot}) between 1 and 80)`,
    ),
    check(
      'completion_retros_label_scope_check',
      sql`${t.labelScopeApplied} = ${t.labelScopeRequested}
        or (${t.labelScopeRequested} = 'institution' and ${t.labelScopeApplied} in ('institution_kind', 'none'))
        or (${t.labelScopeRequested} = 'institution_kind' and ${t.labelScopeApplied} = 'none')`,
    ),
    check(
      'completion_retros_named_scope_check',
      sql`${t.displayMode} = 'anonymous' or (${t.labelScopeRequested} = 'institution' and ${t.labelScopeApplied} = 'institution')`,
    ),
    check(
      'completion_retros_institution_label_check',
      sql`(${t.labelScopeApplied} = 'none') = (${t.institutionLabel} is null)
        and (${t.institutionLabel} is null or char_length(${t.institutionLabel}) between 1 and 100)`,
    ),
    check(
      'completion_retros_cohort_label_check',
      sql`${t.cohortLabel} is null or (${t.displayMode} <> 'anonymous' and char_length(${t.cohortLabel}) between 1 and 20)`,
    ),
    check('completion_retros_withdrawn_check', sql`${t.status} <> 'withdrawn' or ${t.withdrawnAt} is not null`),
  ],
)

// ── 캠퍼스 커뮤니티: 공간·멤버십·게시판 (C-02, PROOFU_EVOLUTION_PLAN §8.9.2–§8.9.4, SYSTEM_DESIGN §6.7, ADR 0019) ─────────────
//
// 이 테이블들은 web `server/modules/community`만 읽고 씁니다. 공개 조회 경로(`/api/v1/public/**`, 검색 색인 search_documents, 과목 집계,
// 공개 release)는 이 테이블을 읽지 않습니다(SYSTEM_DESIGN §8.2·§11). 예외는 운영(신고 처리·탈퇴 정리)뿐입니다.
//
// C-05(ADR 0021): 경계 검사(apps/web/test/community-visibility)는 머리말에 "커뮤니티"가 들어간 구역의 pgTable을 커뮤니티 테이블로 읽습니다.
// C-04 이후의 커뮤니티 테이블(글·댓글·스레드 익명 번호·공감·모집 등)도 이 구역에 두세요. 다른 구역에 두면 검사가 실패합니다.

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
    /** 사용자 방 템플릿(A-01, ADR 0038). alumni는 user_room만(check). P2 alumni 플래그가 꺼져 있으면 general처럼 동작합니다. */
    template: communitySpaceTemplate('template').notNull().default('general'),
    /** 토픽 분류(A-05, ADR 0042). kind = topic일 때만 있습니다(check). */
    topicCategory: topicCategory('topic_category'),
    /**
     * 기수 방(I-02, ADR 0044): 기관 기수. 사용자 방 + school_id(그 기관)일 때만(check). 그 기관·그 기수의 active 인증만 들어오고 읽습니다.
     * 기수마다 보관되지 않은 기수 방 하나(부분 unique).
     */
    cohortId: uuid('cohort_id').references(() => institutionCohorts.id),
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
    uniqueIndex('community_spaces_cohort_room_key').on(t.cohortId).where(sql`${t.cohortId} is not null and ${t.status} <> 'archived'`),
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
    check('community_spaces_template_check', sql`${t.template}::text = 'general' or ${t.kind}::text = 'user_room'`),
    check('community_spaces_cohort_check', sql`${t.cohortId} is null or (${t.kind}::text = 'user_room' and ${t.schoolId} is not null)`),
    // A-05(ADR 0042): 토픽은 학교에 묶이지 않고 이름 표시가 소속 표시 익명으로 고정, 소속 표시 익명은 토픽에만. enum 값을 같은 migration에서 더해 text로 비교합니다.
    check('community_spaces_topic_category_check', sql`(${t.kind}::text = 'topic') = (${t.topicCategory} is not null)`),
    check(
      'community_spaces_topic_check',
      sql`(${t.kind}::text <> 'topic' or (${t.schoolId} is null and ${t.currentNameMode}::text = 'affiliated_anonymous'))
        and (${t.kind}::text = 'topic' or ${t.currentNameMode}::text <> 'affiliated_anonymous')`,
    ),
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

/**
 * 이름 표시 방식 변경 이력(C-03, SYSTEM_DESIGN §6.7 NameModeChange, ADR 0020). 행을 지우지 않는 이력입니다(상태만 scheduled → applied/cancelled).
 * - 사용자 방·스터디 방의 방장만 예약합니다. effective_at = requested_at + 7일(check), 공간마다 scheduled 하나(부분 unique).
 * - worker(`name-mode-changes`, 1분마다)가 effective_at이 지난 예약을 적용합니다(조건부 update라 여러 번·동시에 돌아도 한 번만).
 * - 이미 쓴 글·댓글은 작성 시점의 name_mode를 가지므로 이 행이 바꾸지 않습니다(C-04).
 * - requested_by·cancelled_by는 탈퇴 정리 때 null(이력 행은 남음).
 * - join_policy_adjusted: 실명으로 바꾸며 자유 가입을 방장 승인으로 바꿨는지(예약 때 한 번, 취소해도 되돌리지 않음).
 */
export const nameModeChanges = pgTable(
  'name_mode_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    fromMode: communityNameMode('from_mode').notNull(),
    toMode: communityNameMode('to_mode').notNull(),
    requestedBy: uuid('requested_by').references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    status: nameModeChangeStatus('status').notNull().default('scheduled'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    joinPolicyAdjusted: boolean('join_policy_adjusted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('name_mode_changes_one_scheduled_key').on(t.spaceId).where(sql`${t.status} = 'scheduled'`),
    index('name_mode_changes_space_requested_idx').on(t.spaceId, t.requestedAt),
    index('name_mode_changes_due_idx').on(t.effectiveAt).where(sql`${t.status} = 'scheduled'`),
    check('name_mode_changes_modes_check', sql`${t.fromMode} <> ${t.toMode}`),
    check('name_mode_changes_delay_check', sql`${t.effectiveAt} = ${t.requestedAt} + interval '7 days'`),
    check('name_mode_changes_applied_check', sql`(${t.status} = 'applied') = (${t.appliedAt} is not null)`),
    check('name_mode_changes_cancelled_check', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
    check('name_mode_changes_cancelled_by_check', sql`${t.cancelledBy} is null or ${t.status} = 'cancelled'`),
  ],
)

/**
 * 커뮤니티 알림(C-03, ADR 0020). 화면 안(`/community/notices`)에서만 보이고 메일·푸시는 없습니다. 받는 사람은 알림을 만든 순간의 그 공간
 * active 멤버뿐입니다(나감·내보냄·승인 대기 제외). payload는 허용 목록(@peerchive/domain sanitizeNoticePayload: 방식 둘·적용 시각·가입 방식
 * 조정 여부)만이며 공간 이름은 읽을 때 지금 멤버십을 확인하고 붙입니다. 같은 변경·종류·사람에는 한 행(worker 재시도에도 중복 없음).
 * 탈퇴 정리 때 받는 사람의 행을 지웁니다.
 */
export const communityNotices = pgTable(
  'community_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 공간 소식이면 그 공간. 모집 알림(C-07)은 공간 없이 과목에만 걸린 모집도 있어 null일 수 있습니다(그때는 recruitment_id). */
    spaceId: uuid('space_id').references(() => communitySpaces.id),
    kind: communityNoticeKind('kind').notNull(),
    /** 모집 알림(recruitment_invited·recruitment_not_selected·recruitment_cancelled, C-07)의 모집. */
    recruitmentId: uuid('recruitment_id').references((): AnyPgColumn => recruitments.id),
    nameModeChangeId: uuid('name_mode_change_id').references(() => nameModeChanges.id),
    /** 새 댓글 알림(post_commented, C-04)의 글. */
    postId: uuid('post_id').references((): AnyPgColumn => communityPosts.id),
    /** 아카이브로 옮기기 알림(C-09: 동의 요청·끝남·취소)의 요청. payload는 옮길 곳 종류만. */
    archiveTransferId: uuid('archive_transfer_id').references((): AnyPgColumn => archiveTransfers.id),
    payload: jsonb('payload').$type<Record<string, string | boolean | number>>().notNull().default({}),
    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('community_notices_change_kind_user_key').on(t.nameModeChangeId, t.kind, t.userId).where(sql`${t.nameModeChangeId} is not null`),
    index('community_notices_user_created_idx').on(t.userId, t.createdAt),
    // 새 댓글 알림은 읽기 전까지 글·사람마다 한 행(count를 올림).
    // 글 알림은 읽기 전까지 글·사람·종류마다 한 행(새 댓글은 count를 올림, C-06의 임시 숨김·복원 알림도 글마다 한 행).
    // 종류를 조건(where)이 아니라 열로 둡니다: enum을 text로 바꾸는 식은 IMMUTABLE이 아니라 부분 인덱스 조건에 쓸 수 없고, 리터럴 비교는
    // 처음부터 migration을 한 트랜잭션에서 돌릴 때 같은 트랜잭션에서 더한 enum 값이라 거부됩니다.
    uniqueIndex('community_notices_post_unread_key').on(t.postId, t.userId, t.kind).where(sql`${t.postId} is not null and ${t.readAt} is null`),
    check('community_notices_target_check', sql`(${t.postId} is null) or (${t.nameModeChangeId} is null)`),
    check('community_notices_payload_object_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
    // C-07: 공간 소식 또는 모집 알림 중 하나 이상(모집 알림은 사람·모집·종류마다 한 행).
    check('community_notices_subject_check', sql`${t.spaceId} is not null or ${t.recruitmentId} is not null`),
    uniqueIndex('community_notices_recruitment_kind_user_key').on(t.recruitmentId, t.kind, t.userId).where(sql`${t.recruitmentId} is not null`),
    // C-09: 옮기기 알림은 요청·사람·종류마다 한 행.
    uniqueIndex('community_notices_transfer_kind_user_key').on(t.archiveTransferId, t.kind, t.userId).where(sql`${t.archiveTransferId} is not null`),
  ],
)

// C-04: 글·댓글·스레드 익명 번호·공감(ADR 0022). 같은 커뮤니티 구역이므로 C-05 경계 검사가 자동으로 덮습니다.

/**
 * 커뮤니티 글(C-04, SYSTEM_DESIGN §6.7 Post).
 * - name_mode: **쓰는 순간 고정**(ADR 0020 계약). 같은 트랜잭션에서 공간 행을 FOR SHARE로 잠그고 @peerchive/domain nameModeAtWrite가 돌려준
 *   값만 넣습니다. 이 열·author_id·space_id·board_id를 바꾸는 UPDATE는 DB 트리거(community_posts_frozen_columns, migration 0020)가 거부합니다.
 * - space_id는 board의 공간(조회·잠금용 복사). 지운 글(deleted_by_author)은 제목·본문을 비우고 행은 남깁니다(스레드 익명 번호·댓글 유지).
 *   가린 글(hidden·auto_hidden)은 본문을 남깁니다(이의제기로 되돌릴 수 있게). 탈퇴 정리는 제목·본문을 비우고 deleted_by_author로 바꿉니다.
 * - version: 고칠 때마다 +1(낙관적 동시성). edited_at: 마지막으로 고친 시각.
 */
export const communityPosts = pgTable(
  'community_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    nameMode: communityNameMode('name_mode').notNull(),
    /**
     * 작성 시점의 페르소나(S-02, SYSTEM_DESIGN §6.7.1 "글의 페르소나 귀속", ADR 0029). real이면 그 사람의 실명 페르소나, display면 표시명 페르소나(없으면 null).
     * **anonymous면 항상 null**(check). 넣을 때 트리거(community_persona_attribution_guard)가 페르소나의 주인 = author_id, 종류 = name_mode를 확인하고,
     * 고정 열 트리거가 null로 비우는 것(탈퇴 정리) 말고는 바꾸지 못하게 합니다. 이름 표시(작성자 표시)는 아직 이 열을 쓰지 않습니다(ADR 0029).
     */
    personaId: uuid('persona_id').references(() => personas.id),
    /**
     * 소속 표시 익명(A-05, ADR 0042) 글의 소속 표시. 모두 **작성 시점에 고정**(고정 열 트리거): 이후 소속 변경·인원 증가로 바뀌지 않습니다.
     * - affiliation_id: 표시에 쓴 소속(운영자 전용 — 공개 DTO에는 문자열만). 표시 안 함이면 null, 탈퇴 정리는 null로 비웁니다(비우기만 허용).
     * - label_scope_requested: 작성자가 고른 범위, label_scope_applied: 임계값을 적용한 범위(고른 것보다 좁지 않음, check).
     * - affiliation_label: `○○대 · 졸업생`·`부트캠프 수료생` 같은 문자열(applied = none이면 null). 학과·기수·입학연도는 넣지 않습니다.
     * 다른 방식의 글은 넷 모두 null입니다(check).
     */
    affiliationId: uuid('affiliation_id').references((): AnyPgColumn => institutionAffiliations.id),
    labelScopeRequested: affiliationLabelScope('label_scope_requested'),
    labelScopeApplied: affiliationLabelScope('label_scope_applied'),
    affiliationLabel: text('affiliation_label'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: communityItemStatus('status').notNull().default('published'),
    /**
     * 채택된 답변(C-09, ADR 0025): 질문 게시판 글의 글쓴이가 고른 이 글의 최상위 댓글 하나(서비스가 확인). 고정 열 트리거(0020)는 이 열을 막지 않습니다.
     */
    acceptedCommentId: uuid('accepted_comment_id').references((): AnyPgColumn => communityComments.id),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('community_posts_board_created_idx').on(t.boardId, t.createdAt, t.id),
    index('community_posts_author_idx').on(t.authorId),
    index('community_posts_space_idx').on(t.spaceId),
    index('community_posts_persona_idx').on(t.personaId),
    // 0~1단계(익명·소속 표시 익명)는 페르소나가 없습니다(S-02, A-05). affiliated_anonymous는 같은 migration에서 더해 text로 비교합니다.
    check('community_posts_persona_check', sql`${t.nameMode}::text not in ('anonymous', 'affiliated_anonymous') or ${t.personaId} is null`),
    index('community_posts_affiliation_idx').on(t.affiliationId),
    // A-05(ADR 0042): 소속 표시 열은 소속 표시 익명 글에만, 표시 범위는 고른 것보다 좁지 않음(institution → institution_kind → none, 두 단계 임계값), 표시 안 함이면 문자열 없음.
    check(
      'community_posts_affiliation_mode_check',
      sql`(${t.nameMode}::text = 'affiliated_anonymous') = (${t.labelScopeRequested} is not null and ${t.labelScopeApplied} is not null)
        and (${t.nameMode}::text = 'affiliated_anonymous' or (${t.affiliationId} is null and ${t.affiliationLabel} is null))`,
    ),
    check(
      'community_posts_label_scope_check',
      sql`${t.labelScopeApplied} is null or ${t.labelScopeApplied} = ${t.labelScopeRequested}
        or (${t.labelScopeRequested} = 'institution' and ${t.labelScopeApplied} in ('institution_kind', 'none'))
        or (${t.labelScopeRequested} = 'institution_kind' and ${t.labelScopeApplied} = 'none')`,
    ),
    check(
      'community_posts_affiliation_label_check',
      sql`${t.labelScopeApplied} is null or ((${t.labelScopeApplied} = 'none') = (${t.affiliationLabel} is null)
        and (${t.affiliationLabel} is null or char_length(${t.affiliationLabel}) between 1 and 100))`,
    ),

    check(
      'community_posts_content_check',
      sql`(${t.status} = 'deleted_by_author' and ${t.title} = '' and ${t.body} = '' and ${t.deletedAt} is not null)
        or (${t.status} <> 'deleted_by_author' and char_length(${t.title}) between 1 and 120 and char_length(${t.body}) between 1 and 10000 and ${t.deletedAt} is null)`,
    ),
    check('community_posts_version_check', sql`${t.version} >= 1`),
  ],
)

/**
 * 커뮤니티 댓글(C-04, SYSTEM_DESIGN §6.7 Comment). 답글은 한 단계까지(parent는 같은 글의 최상위 댓글, 서비스가 확인).
 * name_mode는 **댓글 자신의 작성 시점 방식**입니다(글의 방식이 아님: 글을 쓴 뒤 공간 방식이 바뀌면 그 뒤 댓글은 새 방식).
 * 익명 번호는 스레드(글) 단위로 thread_aliases가 정합니다. 고정 열 트리거·지우기·탈퇴 정리 규칙은 글과 같습니다.
 */
export const communityComments = pgTable(
  'community_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => communityPosts.id),
    parentCommentId: uuid('parent_comment_id').references((): AnyPgColumn => communityComments.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    nameMode: communityNameMode('name_mode').notNull(),
    /** 작성 시점의 페르소나(S-02). 규칙은 글과 같습니다(anonymous·affiliated_anonymous면 null, 트리거로 주인·종류 확인). */
    personaId: uuid('persona_id').references(() => personas.id),
    /** 소속 표시(A-05, ADR 0042). 규칙은 글과 같습니다(작성 시점 고정, 소속 표시 익명 댓글에만). */
    affiliationId: uuid('affiliation_id').references((): AnyPgColumn => institutionAffiliations.id),
    labelScopeRequested: affiliationLabelScope('label_scope_requested'),
    labelScopeApplied: affiliationLabelScope('label_scope_applied'),
    affiliationLabel: text('affiliation_label'),
    body: text('body').notNull(),
    status: communityItemStatus('status').notNull().default('published'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('community_comments_post_created_idx').on(t.postId, t.createdAt, t.id),
    index('community_comments_author_idx').on(t.authorId),
    index('community_comments_parent_idx').on(t.parentCommentId),
    index('community_comments_persona_idx').on(t.personaId),
    check('community_comments_persona_check', sql`${t.nameMode}::text not in ('anonymous', 'affiliated_anonymous') or ${t.personaId} is null`),
    index('community_comments_affiliation_idx').on(t.affiliationId),
    // A-05(ADR 0042): 소속 표시 열은 소속 표시 익명 글에만, 표시 범위는 고른 것보다 좁지 않음(institution → institution_kind → none, 두 단계 임계값), 표시 안 함이면 문자열 없음.
    check(
      'community_comments_affiliation_mode_check',
      sql`(${t.nameMode}::text = 'affiliated_anonymous') = (${t.labelScopeRequested} is not null and ${t.labelScopeApplied} is not null)
        and (${t.nameMode}::text = 'affiliated_anonymous' or (${t.affiliationId} is null and ${t.affiliationLabel} is null))`,
    ),
    check(
      'community_comments_label_scope_check',
      sql`${t.labelScopeApplied} is null or ${t.labelScopeApplied} = ${t.labelScopeRequested}
        or (${t.labelScopeRequested} = 'institution' and ${t.labelScopeApplied} in ('institution_kind', 'none'))
        or (${t.labelScopeRequested} = 'institution_kind' and ${t.labelScopeApplied} = 'none')`,
    ),
    check(
      'community_comments_affiliation_label_check',
      sql`${t.labelScopeApplied} is null or ((${t.labelScopeApplied} = 'none') = (${t.affiliationLabel} is null)
        and (${t.affiliationLabel} is null or char_length(${t.affiliationLabel}) between 1 and 100))`,
    ),

    check(
      'community_comments_content_check',
      sql`(${t.status} = 'deleted_by_author' and ${t.body} = '' and ${t.deletedAt} is not null)
        or (${t.status} <> 'deleted_by_author' and char_length(${t.body}) between 1 and 3000 and ${t.deletedAt} is null)`,
    ),
    check('community_comments_version_check', sql`${t.version} >= 1`),
    check('community_comments_parent_self_check', sql`${t.parentCommentId} is null or ${t.parentCommentId} <> ${t.id}`),
  ],
)

/**
 * 스레드 익명 번호(C-04, SYSTEM_DESIGN §6.7 ThreadAlias). 글(스레드)마다 사람마다 번호 하나: 익명 글의 글쓴이 0(`글쓴이`), 다른 사람은
 * 그 스레드에 처음 익명으로 쓴 순서대로 1, 2, …(@peerchive/domain assignThreadAlias). 지워도 번호를 다시 쓰지 않고(행을 지우지 않음),
 * 스레드 사이에 번호·키를 공유하지 않습니다. 이 행의 id·user_id는 어떤 응답에도 나가지 않습니다. UPDATE는 트리거가 거부합니다.
 * 탈퇴 정리도 행을 남깁니다(users 행은 가명 처리되어 남음 — 스레드의 다른 번호가 바뀌지 않게).
 */
export const threadAliases = pgTable(
  'thread_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => communityPosts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    aliasNo: integer('alias_no').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('thread_aliases_post_user_key').on(t.postId, t.userId),
    uniqueIndex('thread_aliases_post_alias_key').on(t.postId, t.aliasNo),
    check('thread_aliases_alias_no_check', sql`${t.aliasNo} >= 0`),
  ],
)

/**
 * 공감(C-04, SYSTEM_DESIGN §6.7 Reaction). 글 또는 댓글 하나에 사람마다 한 번(부분 unique). 공감만 있고 비추천은 없습니다.
 * 개수만 보여 주고 누가 눌렀는지는 어떤 응답에도 싣지 않습니다. 탈퇴 정리 때 그 사람의 행을 지웁니다.
 */
export const communityReactions = pgTable(
  'community_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id').references(() => communityPosts.id),
    commentId: uuid('comment_id').references(() => communityComments.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: communityReactionKind('kind').notNull().default('empathy'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('community_reactions_post_user_key').on(t.postId, t.userId, t.kind).where(sql`${t.postId} is not null`),
    uniqueIndex('community_reactions_comment_user_key').on(t.commentId, t.userId, t.kind).where(sql`${t.commentId} is not null`),
    index('community_reactions_user_idx').on(t.userId),
    check('community_reactions_target_check', sql`(${t.postId} is null) <> (${t.commentId} is null)`),
  ],
)

// C-06: 이용 제한·작성자 확인 기록·제재 요청(ADR 0023). 같은 커뮤니티 구역이므로 C-05 경계 검사가 자동으로 덮습니다.

/**
 * 운영자 작성자 확인 기록(C-06, SYSTEM_DESIGN §8.1 `operator_identity_lookup`). 운영자가 사유를 적고 글·댓글 하나의 작성자를 확인할 때마다 한 행.
 * - 사유(reason)는 여기에만 둡니다(감사 metadata에는 id만). 근거 신고·제재 요청은 선택(법적 요청 대응 등).
 * - author_id: 확인한 작성자(제재 발급에만 씀, 조회 기록 화면에는 싣지 않음). 그 작성자가 탈퇴 정리되면 null(기록은 남김).
 * - operator_id는 탈퇴 정리 뒤에도 가명 처리된 users 행을 가리킵니다(감사와 같음).
 */
export const communityAuthorLookups = pgTable(
  'community_author_lookups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => users.id),
    targetType: text('target_type').notNull(),
    postId: uuid('post_id').references(() => communityPosts.id),
    commentId: uuid('comment_id').references(() => communityComments.id),
    authorId: uuid('author_id').references(() => users.id),
    reason: text('reason').notNull(),
    reportId: uuid('report_id').references((): AnyPgColumn => reports.id),
    requestId: uuid('request_id').references((): AnyPgColumn => communitySanctionRequests.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('community_author_lookups_created_idx').on(t.createdAt),
    index('community_author_lookups_operator_idx').on(t.operatorId, t.createdAt),
    index('community_author_lookups_post_idx').on(t.postId),
    index('community_author_lookups_comment_idx').on(t.commentId),
    index('community_author_lookups_author_idx').on(t.authorId),
    check(
      'community_author_lookups_target_check',
      sql`(${t.targetType} = 'post' and ${t.postId} is not null and ${t.commentId} is null) or (${t.targetType} = 'comment' and ${t.commentId} is not null and ${t.postId} is null)`,
    ),
    check('community_author_lookups_reason_check', sql`char_length(${t.reason}) between 1 and 1000`),
    check('community_author_lookups_basis_check', sql`${t.reportId} is null or ${t.requestId} is null`),
  ],
)

/**
 * 방 운영진(방장·admin·moderator, 공식 페이지 모더레이터)의 제재 요청(C-06, SYSTEM_DESIGN §8.1 "대상 글을 지정해 요청").
 * 요청한 사람은 작성자를 모르며 응답에도 작성자가 없습니다. 운영자가 작성자 확인 → 제재 발급(resolved) 또는 기각(dismissed)합니다.
 * 같은 사람·대상의 처리 전 요청은 하나(부분 unique). details는 운영자만 봅니다(탈퇴 정리 때 지움).
 */
export const communitySanctionRequests = pgTable(
  'community_sanction_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    postId: uuid('post_id').references(() => communityPosts.id),
    commentId: uuid('comment_id').references(() => communityComments.id),
    targetKey: text('target_key').notNull(),
    reason: reportReason('reason').notNull(),
    details: text('details'),
    status: sanctionRequestStatus('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id),
    closeNote: text('close_note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('community_sanction_requests_open_key').on(t.requestedBy, t.targetKey).where(sql`${t.status} = 'open'`),
    index('community_sanction_requests_space_idx').on(t.spaceId, t.createdAt),
    index('community_sanction_requests_status_idx').on(t.status, t.createdAt),
    check('community_sanction_requests_target_check', sql`(${t.postId} is null) <> (${t.commentId} is null)`),
    check('community_sanction_requests_details_check', sql`${t.details} is null or char_length(${t.details}) between 1 and 1000`),
    check('community_sanction_requests_close_note_check', sql`${t.closeNote} is null or char_length(${t.closeNote}) between 1 and 1000`),
    check('community_sanction_requests_closed_check', sql`(${t.status} = 'open') = (${t.closedAt} is null)`),
  ],
)

/**
 * 이용 제한(C-06, SYSTEM_DESIGN §6.7 CommunitySanction). 운영자가 작성자 확인(lookup_id, 같은 운영자·24시간 안) 뒤에만 발급합니다.
 * - scope community(모든 공간) / space(그 글·댓글의 공간 하나). level warning(알림만) / write_suspended(until까지) / permanent(커뮤니티 전체).
 * - 커뮤니티 쓰기 정책 함수(canWriteBoard·canReact·canCreateRoom)에서만 읽고 과제 공간·포트폴리오·공개 프로필·과목 허브에는 영향이 없습니다.
 * - 사유: 내부 메모·당사자용 사유는 짝인 moderation_actions 행(kind sanction, action_id)에 있습니다(이의제기·안내를 그대로 씀).
 * - 되돌림(revoked_*): 운영자 해제 또는 이의제기 되돌림. 행은 지우지 않습니다(탈퇴 정리 때 그 사람의 행만 지움).
 */
export const communitySanctions = pgTable(
  'community_sanctions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    scope: communitySanctionScope('scope').notNull(),
    spaceId: uuid('space_id').references(() => communitySpaces.id),
    level: communitySanctionLevel('level').notNull(),
    until: timestamp('until', { withTimezone: true }),
    actionId: uuid('action_id')
      .notNull()
      .unique()
      .references(() => moderationActions.id),
    lookupId: uuid('lookup_id')
      .notNull()
      .references(() => communityAuthorLookups.id),
    reportId: uuid('report_id').references((): AnyPgColumn => reports.id),
    requestId: uuid('request_id').references(() => communitySanctionRequests.id),
    issuedBy: uuid('issued_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
  },
  (t) => [
    index('community_sanctions_user_idx').on(t.userId, t.revokedAt),
    index('community_sanctions_space_idx').on(t.spaceId),
    index('community_sanctions_request_idx').on(t.requestId),
    check('community_sanctions_scope_check', sql`(${t.scope} = 'space') = (${t.spaceId} is not null)`),
    check(
      'community_sanctions_level_check',
      sql`(${t.level} = 'write_suspended' and ${t.until} is not null) or (${t.level} <> 'write_suspended' and ${t.until} is null)`,
    ),
    check('community_sanctions_permanent_check', sql`${t.level} <> 'permanent' or ${t.scope} = 'community'`),
    check('community_sanctions_revoked_check', sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`),
  ],
)

// C-07: 모집(팀원 찾기·스터디 모집)·지원(ADR 0024). 같은 커뮤니티 구역이므로 C-05 경계 검사(테이블 목록·소스 경계·센티넬)가 자동으로 덮습니다.

/**
 * 모집(C-07, SYSTEM_DESIGN §6.7 Recruitment, PROOFU_EVOLUTION_PLAN §8.8·§8.9.5). 팀원 찾기와 스터디 모집이 같은 테이블이고 kind로 나눕니다.
 * - 올린 곳: space_id(공식 페이지·사용자 방의 모집 게시판) 또는 course_id만(과목 맥락, 그 학교 인증 사용자만 봄). 팀원 찾기는 과목 필수.
 *   읽기는 공간의 읽기 정책(canReadSpace) 또는 과목 학교(정본) active 인증입니다(@peerchive/domain canViewRecruitment).
 * - 모집자(created_by)는 응답에 나오지 않습니다(본인 여부 `mine`만). 지원자 목록은 모집자만 봅니다.
 * - 마감(closed): 팀원 찾기 → 비공개 과제 공간(result_project_id, 학기가 있으면 엠바고), 스터디 → 초대 전용 스터디 방(result_space_id).
 *   취소(cancelled)·마감 모두 closed_at. 탈퇴 정리는 그 사람의 모집 중인 글을 취소하고(지원자에게 취소 알림) 모든 모집 글의 제목·소개를 비웁니다(행은 남김).
 * - hidden_at: 운영 조치(hide_recruitment)로 가림. 모집자 외에는 404, 지원을 받지 않습니다.
 */
export const recruitments = pgTable(
  'recruitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: recruitmentKind('kind').notNull(),
    spaceId: uuid('space_id').references(() => communitySpaces.id),
    /** 정본 과목(만들 때 병합을 따라감). */
    courseId: uuid('course_id').references(() => courses.id),
    /** 정본 학기(그 과목의 학기). 팀원 찾기를 마감하면 과제 공간에 연결되어 엠바고가 걸립니다(T-10). */
    termId: uuid('term_id').references(() => courseTerms.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** 모집 인원(수락할 수 있는 지원자 수, 모집자 제외) 2~20. */
    capacity: integer('capacity').notNull(),
    /** 스터디 방 이름 표시 방식(스터디만, 표시명 기본). 팀원 찾기는 null. */
    roomNameMode: communityNameMode('room_name_mode'),
    status: recruitmentStatus('status').notNull().default('open'),
    closesAt: timestamp('closes_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    resultProjectId: uuid('result_project_id').references(() => projects.id),
    resultSpaceId: uuid('result_space_id').references(() => communitySpaces.id),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  },
  (t) => [
    index('recruitments_space_created_idx').on(t.spaceId, t.createdAt),
    index('recruitments_course_created_idx').on(t.courseId, t.createdAt),
    index('recruitments_created_by_idx').on(t.createdBy),
    check('recruitments_host_check', sql`${t.spaceId} is not null or ${t.courseId} is not null`),
    check('recruitments_team_course_check', sql`${t.kind}::text <> 'team' or ${t.courseId} is not null`),
    check('recruitments_term_course_check', sql`${t.termId} is null or ${t.courseId} is not null`),
    check('recruitments_room_name_mode_check', sql`(${t.kind}::text = 'study') = (${t.roomNameMode} is not null)`),
    check('recruitments_capacity_check', sql`${t.capacity} between 2 and 20`),
    check(
      'recruitments_title_check',
      // 탈퇴 정리는 모집 글을 취소(모집 중이었으면)하고 제목·소개를 비웁니다. 비운 행은 모집 중이 아닙니다.
      sql`char_length(${t.title}) between 1 and 80 or (${t.status}::text <> 'open' and ${t.title} = '' and ${t.description} = '')`,
    ),
    check('recruitments_description_check', sql`char_length(${t.description}) <= 2000`),
    check('recruitments_closed_check', sql`(${t.status}::text = 'open') = (${t.closedAt} is null)`),
    check('recruitments_result_project_check', sql`${t.resultProjectId} is null or (${t.kind}::text = 'team' and ${t.status}::text = 'closed')`),
    check('recruitments_result_space_check', sql`${t.resultSpaceId} is null or (${t.kind}::text = 'study' and ${t.status}::text = 'closed')`),
  ],
)

/**
 * 지원(C-07, SYSTEM_DESIGN §6.7 Application). 모집·사람마다 하나(unique). **모집자만** 목록을 보고, 지원자는 자기 상태만 봅니다.
 * - 순위·점수·활동량·거절 사유 열이 없습니다(§8.8). 목록은 created_at 순서로만 보여 줍니다.
 * - 첨부(선택): 지원자 자신의 공개 프로필 handle, 자신이 팀원인 공개 사례(publication) slug 최대 3개. 지원할 때 확인하고 읽을 때 다시 확인합니다
 *   (철회·숨김된 것은 응답에서 빠짐).
 * - 마감 뒤 선정된 지원자가 초대를 받을 때 만든 과제 초대(project_invitation_id)·공간 초대(space_invitation_id)를 가리킵니다(다시 받으면 이전 것을 취소).
 *   초대 원문 토큰은 저장하지 않습니다(해시만 각 초대 테이블에).
 * - message_hidden_at: 운영 조치(hide_application)로 메시지를 가림(모집자에게 자리 표시).
 * - 탈퇴 정리: 그 사람의 지원 행은 지웁니다(신고·조치가 가리키면 메시지·첨부를 비운 행으로 남김).
 */
export const recruitmentApplications = pgTable(
  'recruitment_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recruitmentId: uuid('recruitment_id')
      .notNull()
      .references(() => recruitments.id),
    applicantId: uuid('applicant_id')
      .notNull()
      .references(() => users.id),
    message: text('message').notNull().default(''),
    profileHandle: text('profile_handle'),
    caseSlugs: text('case_slugs').array().notNull().default(sql`'{}'::text[]`),
    status: applicationStatus('status').notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    projectInvitationId: uuid('project_invitation_id').references(() => invitations.id),
    spaceInvitationId: uuid('space_invitation_id').references(() => spaceInvitations.id),
    messageHiddenAt: timestamp('message_hidden_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('recruitment_applications_recruitment_applicant_key').on(t.recruitmentId, t.applicantId),
    index('recruitment_applications_recruitment_created_idx').on(t.recruitmentId, t.createdAt, t.id),
    index('recruitment_applications_applicant_idx').on(t.applicantId),
    check('recruitment_applications_message_check', sql`char_length(${t.message}) <= 500`),
    check('recruitment_applications_cases_check', sql`cardinality(${t.caseSlugs}) <= 3`),
    check('recruitment_applications_handle_check', sql`${t.profileHandle} is null or ${t.profileHandle} ~ '^[a-z0-9-]{3,30}$'`),
    check('recruitment_applications_decided_check', sql`(${t.status}::text = 'pending') = (${t.decidedAt} is null)`),
  ],
)

// C-09: 아카이브로 옮기기(ADR 0025). 커뮤니티 글·댓글을 가리키므로 커뮤니티 구역에 둡니다(C-05 경계 검사가 자동으로 덮음).
// 방향은 커뮤니티 → 아카이브뿐입니다: 이 행이 아카이브 쪽 복사본(course_qa_items·senior_notes·log_entries)을 가리키고, 아카이브 테이블은 이 행이나
// 다른 커뮤니티 테이블을 가리키지 않습니다(공개 읽기 경로가 커뮤니티 테이블에 닿을 길이 없음).

/**
 * 아카이브로 옮기기 요청(C-09, SYSTEM_DESIGN §6.7 ArchiveTransfer).
 * - source: 원 글(source_post_id)과, 답변을 옮기면 채택된 답변(source_comment_id). 원 글은 커뮤니티에 그대로 남고 열람 범위도 바뀌지 않습니다.
 * - snapshot: 요청 때 얼린 복사할 글({questionTitle, questionBody, answerBody}). 동의는 content_hash(@peerchive/domain archiveHashInput →
 *   canonicalJson → SHA-256)에 묶입니다. 끝나거나(done) 취소되면(cancelled) snapshot을 null로 지웁니다(해시만 남김).
 * - 동의: archive_transfer_consents(사람마다 한 행). 모두 같은 해시로 동의하면 같은 트랜잭션에서 복사본을 만들고 done.
 * - 대상: course_qa → course_qa_item_id, stuck_log → stuck_log_id(+ solution_log_id), senior_note → senior_note_id(초안).
 *   A-06(ADR 0043): senior_note는 토픽의 내 댓글(답변)도 원본이 될 수 있습니다(source_comment_id = 그 댓글, 질문 글은 복사하지 않음).
 * - 취소: cancel_reason(@peerchive/domain ARCHIVE_CANCEL_REASONS). 14일(expires_at)이 지나면 읽거나 쓸 때 expired로 닫습니다.
 * - 같은 글·대상의 진행 중 요청은 하나(부분 unique, 조건은 enum 리터럴 대신 닫힌 시각 열로).
 * - 이름 표시 페르소나(SYSTEM_DESIGN §6.7.1 persona_id)는 S-01에서 더합니다. 지금은 동의 행의 display_mode·display_label이 복사본 이름입니다.
 */
export const archiveTransfers = pgTable(
  'archive_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    target: archiveTransferTarget('target').notNull(),
    status: archiveTransferStatus('status').notNull().default('awaiting_consent'),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    sourcePostId: uuid('source_post_id')
      .notNull()
      .references(() => communityPosts.id),
    sourceCommentId: uuid('source_comment_id').references(() => communityComments.id),
    initiatorId: uuid('initiator_id')
      .notNull()
      .references(() => users.id),
    /** 정본 과목(course_qa·senior_note). */
    courseId: uuid('course_id').references(() => courses.id),
    /** 질문한 사람의 비공개 과제(stuck_log). */
    projectId: uuid('project_id').references(() => projects.id),
    /** stuck_log의 막힘 시간 구간(로그 payload.timeBucket). */
    timeBucket: text('time_bucket'),
    snapshot: jsonb('snapshot').$type<{ questionTitle: string; questionBody: string; answerBody: string | null }>(),
    contentHash: text('content_hash').notNull(),
    cancelReason: text('cancel_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    courseQaItemId: uuid('course_qa_item_id').references(() => courseQaItems.id),
    seniorNoteId: uuid('senior_note_id').references(() => seniorNotes.id),
    stuckLogId: uuid('stuck_log_id').references(() => logEntries.id),
    solutionLogId: uuid('solution_log_id').references(() => logEntries.id),
  },
  (t) => [
    uniqueIndex('archive_transfers_open_key').on(t.sourcePostId, t.target).where(sql`${t.completedAt} is null and ${t.cancelledAt} is null`),
    index('archive_transfers_post_idx').on(t.sourcePostId),
    index('archive_transfers_comment_idx').on(t.sourceCommentId),
    index('archive_transfers_initiator_idx').on(t.initiatorId, t.createdAt),
    check('archive_transfers_hash_check', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'archive_transfers_status_check',
      sql`(${t.status}::text = 'awaiting_consent' and ${t.completedAt} is null and ${t.cancelledAt} is null and ${t.snapshot} is not null)
        or (${t.status}::text = 'done' and ${t.completedAt} is not null and ${t.cancelledAt} is null and ${t.snapshot} is null)
        or (${t.status}::text = 'cancelled' and ${t.cancelledAt} is not null and ${t.completedAt} is null and ${t.snapshot} is null and ${t.cancelReason} is not null)`,
    ),
    check(
      'archive_transfers_cancel_reason_check',
      sql`${t.cancelReason} is null or ${t.cancelReason} in ('cancelled_by_initiator', 'declined', 'expired', 'source_unavailable', 'answer_changed', 'account_deleted', 'target_unavailable')`,
    ),
    check(
      'archive_transfers_target_check',
      sql`(${t.target}::text = 'course_qa' and ${t.courseId} is not null and ${t.projectId} is null and ${t.sourceCommentId} is not null)
        or (${t.target}::text = 'stuck_log' and ${t.projectId} is not null and ${t.courseId} is null and ${t.timeBucket} is not null)
        or (${t.target}::text = 'senior_note' and ${t.courseId} is not null and ${t.projectId} is null)`,
    ),
    check(
      'archive_transfers_result_check',
      sql`${t.status}::text <> 'done'
        or (${t.target}::text = 'course_qa' and ${t.courseQaItemId} is not null)
        or (${t.target}::text = 'stuck_log' and ${t.stuckLogId} is not null)
        or (${t.target}::text = 'senior_note' and ${t.seniorNoteId} is not null)`,
    ),
    check('archive_transfers_time_bucket_check', sql`${t.timeBucket} is null or ${t.timeBucket} in ('lt30m', 'lt2h', 'half_day', 'day_plus')`),
  ],
)

/**
 * 옮기기 동의(C-09). 요청에 필요한 사람마다 한 행(질문한 사람·답한 사람·작성자). 요청한 사람의 행은 요청 때 granted.
 * - content_hash: 동의할 때 본 내용의 해시(요청의 content_hash와 같아야 복사됨). display_*: 막힘 Q&A에 쓸 자기 이름(각자 고름).
 * - 요청한 사람에게 상대의 행은 상태만 보입니다(답한 사람이 누구인지·무엇을 골랐는지는 응답에 없음).
 */
export const archiveTransferConsents = pgTable(
  'archive_transfer_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => archiveTransfers.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** asker / answerer / author. */
    role: text('role').notNull(),
    /** pending / granted / declined. */
    status: text('status').notNull().default('pending'),
    displayMode: communityNameMode('display_mode'),
    displayLabel: text('display_label'),
    contentHash: text('content_hash'),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('archive_transfer_consents_transfer_user_key').on(t.transferId, t.userId),
    index('archive_transfer_consents_user_idx').on(t.userId, t.status),
    check('archive_transfer_consents_role_check', sql`${t.role} in ('asker', 'answerer', 'author')`),
    check('archive_transfer_consents_status_check', sql`${t.status} in ('pending', 'granted', 'declined')`),
    check('archive_transfer_consents_decided_check', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
    check('archive_transfer_consents_granted_check', sql`${t.status} <> 'granted' or ${t.contentHash} is not null`),
    check('archive_transfer_consents_label_check', sql`${t.displayLabel} is null or char_length(${t.displayLabel}) between 1 and 40`),
  ],
)

// C-08: 스터디 기록(ADR 0026). 스터디 방(community_spaces)과 내부 과제 공간(projects, kind = study)을 1:1로 잇습니다.
// 커뮤니티 구역이므로 C-05 경계 검사가 자동으로 덮습니다. 방향은 커뮤니티 → 과제뿐이고, 과제 쪽 테이블은 이 행을 가리키지 않습니다.

/**
 * 스터디 기록(C-08, SYSTEM_DESIGN §6.7 StudyRecord, PROOFU_EVOLUTION_PLAN §8.9.5·§8.9.8).
 * - 방장이 기록을 켜면 내부 과제 공간(kind = study)을 만들고 이 행으로 잇습니다. 방·과제 모두 하나씩(unique).
 * - 과제 멤버십(project_members)은 방 멤버십에서 파생됩니다: 방 멤버십을 바꾸는 같은 트랜잭션에서 커뮤니티 모듈이 다시 계산해 씁니다
 *   (@peerchive/domain planStudyRecordSync). 과제 쪽의 초대·역할·내보내기·나가기·소유권 이전은 409 `study_managed`.
 * - 기록을 끄는 경로는 없습니다(공개 사례·동의가 이 과제를 가리킬 수 있으므로). 방이 보관되어도 기록은 남습니다.
 */
export const studyRecords = pgTable(
  'study_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    enabledBy: uuid('enabled_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('study_records_space_id_key').on(t.spaceId), uniqueIndex('study_records_project_id_key').on(t.projectId)],
)

// A-01: 동문회·OB 방의 방별 프로필(ADR 0038). 커뮤니티 구역이므로 C-05·S-02 경계 검사와 social DB 역할 권한 검사가 자동으로 덮습니다
// (social 역할에는 권한을 주지 않음). 공개 프로필·검색·피드·PersonaActivity는 이 테이블을 읽지 않습니다.

/**
 * 방별 프로필(A-01, SYSTEM_DESIGN §6.7.2 RoomProfile, PROOFU_EVOLUTION_PLAN §8.9.9).
 * - (space, user) 하나. alumni 템플릿 방의 active 멤버만 만들고, 방 멤버에게만 보입니다.
 * - display_name: display 방의 방별 이름. real 방은 실명으로 고정이라 쓰지 않습니다(남아 있어도 real 방에서는 읽지 않음).
 * - badges: 자기 신고 배지(current·ob·alumni, 현역·OB는 함께 못 씀). 기수 배지는 cohort_label에서 나옵니다. 인증 표시는 저장하지 않습니다.
 * - 사진(avatar_version_id)은 이번 범위에 없습니다(ADR 0038 — 파일 검사·EXIF 제거·짧은 서명 URL을 붙여 A-02 앨범과 함께).
 * - 방을 나가거나 내보내지거나 탈퇴하면 행을 지웁니다. 방이 익명으로 바뀌면 worker가 지웁니다.
 */
export const roomProfiles = pgTable(
  'room_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    displayName: text('display_name'),
    badges: text('badges').array().notNull().default(sql`'{}'::text[]`),
    cohortLabel: text('cohort_label'),
    bio: text('bio'),
    /** A-07(ADR 0045): 운영 조치(hide_room_item)로 숨김. 다른 멤버에게는 방별 프로필이 없는 것처럼 보입니다(이름은 `방별 이름 없음`). */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('room_profiles_space_user_key').on(t.spaceId, t.userId),
    index('room_profiles_user_id_idx').on(t.userId),
    check('room_profiles_display_name_check', sql`${t.displayName} is null or char_length(${t.displayName}) between 1 and 30`),
    check('room_profiles_cohort_label_check', sql`${t.cohortLabel} is null or char_length(${t.cohortLabel}) between 1 and 20`),
    check('room_profiles_bio_check', sql`${t.bio} is null or char_length(${t.bio}) between 1 and 200`),
    check('room_profiles_badges_check', sql`${t.badges} <@ array['current', 'ob', 'alumni']::text[] and not (${t.badges} @> array['current', 'ob']::text[])`),
  ],
)

/**
 * 기수 변경 이력(A-01). 본인·방장·운영진의 모든 기수 변경을 남깁니다(이전·이후 값, 바꾼 사람, 시각). 방장·운영진과 본인만 봅니다.
 * 대상(subject)이 방을 나가거나 탈퇴하면 그 사람의 이력도 지웁니다(기수는 그 사람의 자기 신고 정보). 바꾼 사람이 탈퇴하면 changed_by만 비웁니다.
 */
export const roomProfileCohortChanges = pgTable(
  'room_profile_cohort_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id),
    changedBy: uuid('changed_by').references(() => users.id),
    fromLabel: text('from_label'),
    toLabel: text('to_label'),
    createdAt: createdAt(),
  },
  (t) => [
    index('room_profile_cohort_changes_subject_idx').on(t.spaceId, t.subjectUserId, t.createdAt),
    index('room_profile_cohort_changes_changed_by_idx').on(t.changedBy),
    check('room_profile_cohort_changes_changed_check', sql`${t.fromLabel} is distinct from ${t.toLabel}`),
  ],
)

// A-02: 동문회·OB 방의 일정·참석 응답·공지 읽음·투표·앨범(ADR 0039). 커뮤니티 구역이므로 C-05·S-02 경계 검사와 social DB 역할 권한 검사가
// 자동으로 덮습니다(social 역할에는 권한을 주지 않음). 공개 프로필·검색·피드·PersonaActivity는 이 테이블을 읽지 않습니다.

/**
 * 일정(A-02, SYSTEM_DESIGN §6.7.2 Event). alumni 방의 방장·운영진이 만듭니다.
 * - 반복은 단순 규칙(none·weekly·monthly) + 끝나는 서울 날짜(repeat_until, 포함)만. 회차는 저장하지 않고 @peerchive/domain eventOccurrences로
 *   계산하며, 회차는 시작 시각의 서울 날짜로 가리킵니다. 시각·반복 규칙은 만든 뒤 바꾸지 않습니다(응답이 가리키는 회차가 바뀌지 않게).
 * - created_by는 만든 사람(탈퇴 정리에서 null). 취소하면 status cancelled + cancelled_at, 응답은 남기되 더 받지 않습니다.
 */
export const roomEvents = pgTable(
  'room_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    title: text('title').notNull(),
    description: text('description'),
    locationText: text('location_text'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    recurrence: roomEventRecurrence('recurrence').notNull().default('none'),
    repeatUntil: date('repeat_until'),
    status: roomEventStatus('status').notNull().default('scheduled'),
    createdBy: uuid('created_by').references(() => users.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** A-07(ADR 0045): 운영 조치(hide_room_item)로 숨김. 목록·응답·응답자 목록에서 빠집니다(방장·운영진 포함). */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('room_events_space_starts_idx').on(t.spaceId, t.startsAt),
    index('room_events_created_by_idx').on(t.createdBy),
    check('room_events_title_check', sql`char_length(${t.title}) between 1 and 80`),
    check('room_events_description_check', sql`${t.description} is null or char_length(${t.description}) between 1 and 1000`),
    check('room_events_location_check', sql`${t.locationText} is null or char_length(${t.locationText}) between 1 and 100`),
    check('room_events_ends_check', sql`${t.endsAt} is null or (${t.endsAt} > ${t.startsAt} and ${t.endsAt} <= ${t.startsAt} + interval '7 days')`),
    check('room_events_repeat_check', sql`(${t.recurrence}::text = 'none') = (${t.repeatUntil} is null)`),
    check('room_events_cancelled_check', sql`(${t.status}::text = 'cancelled') = (${t.cancelledAt} is not null)`),
  ],
)

/**
 * 회차별 참석 응답(A-02, SYSTEM_DESIGN §6.7.2 EventRsvp). (일정, 회차 날짜, 사람) 하나 — 같은 회차에 두 번 응답하면 바꾸기입니다.
 * 회차 날짜가 규칙에 있는지는 서비스가 확인합니다. 응답자 목록은 그 방 active 멤버에게만(방별 프로필 이름, 익명 방은 개수만).
 * 방을 나가거나 내보내지거나 탈퇴하면 그 사람의 응답을 지웁니다.
 */
export const roomEventRsvps = pgTable(
  'room_event_rsvps',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => roomEvents.id),
    occurrenceDate: date('occurrence_date').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    response: rsvpResponse('response').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: 'room_event_rsvps_pkey', columns: [t.eventId, t.occurrenceDate, t.userId] }), index('room_event_rsvps_user_id_idx').on(t.userId)],
)

/**
 * 공지 읽음 표시(A-02, SYSTEM_DESIGN §6.7.2 NoticeRead). alumni 방의 공지 게시판 글에만, (글, 사람) 하나(멱등).
 * API는 **읽음 수와 내가 읽었는지만** 돌려주고 누가 읽었는지는 어디에도(방장·운영진·운영자 화면 포함) 내보내지 않습니다.
 * space_id는 나가기 정리용 복사(글의 공간). 방을 나가거나 내보내지거나 탈퇴하면 그 사람의 행을 지웁니다(읽음 수도 줄어듦).
 */
export const noticeReads = pgTable(
  'notice_reads',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => communityPosts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'notice_reads_pkey', columns: [t.postId, t.userId] }),
    index('notice_reads_user_space_idx').on(t.userId, t.spaceId),
  ],
)

/**
 * 투표(A-02, SYSTEM_DESIGN §6.7.2 Poll). alumni 방의 방장·운영진이 만듭니다(장소·날짜 투표). 글에 붙이지 않고 방에 둡니다(ADR 0039).
 * 선택지는 2~10개 배열(만든 뒤 바꾸지 않음), 마감 시각까지 받습니다(방장·운영진이 일찍 마감하면 closes_at을 그 시각으로).
 * 결과는 선택지별 개수만 — 누가 무엇을 골랐는지는 아무에게도 보이지 않습니다.
 */
export const roomPolls = pgTable(
  'room_polls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    question: text('question').notNull(),
    options: text('options').array().notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    /** A-07(ADR 0045): 운영 조치(hide_room_item)로 숨김. 목록·투표에서 빠집니다. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('room_polls_space_created_idx').on(t.spaceId, t.createdAt),
    index('room_polls_created_by_idx').on(t.createdBy),
    check('room_polls_question_check', sql`char_length(${t.question}) between 1 and 120`),
    check('room_polls_options_check', sql`cardinality(${t.options}) between 2 and 10`),
  ],
)

/**
 * 투표 한 표(A-02, SYSTEM_DESIGN §6.7.2 PollVote). (투표, 사람) 하나 — 두 번 투표할 수 없고 바꾸지 않습니다. option_index는 0부터.
 * 방을 나가거나 내보내지거나 탈퇴하면 그 사람의 표를 지웁니다(집계도 그만큼 줄어듦, 마감한 투표 포함 — ADR 0039).
 */
export const roomPollVotes = pgTable(
  'room_poll_votes',
  {
    pollId: uuid('poll_id')
      .notNull()
      .references(() => roomPolls.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    optionIndex: integer('option_index').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'room_poll_votes_pkey', columns: [t.pollId, t.userId] }),
    index('room_poll_votes_user_id_idx').on(t.userId),
    check('room_poll_votes_option_check', sql`${t.optionIndex} between 0 and 9`),
  ],
)

/**
 * 앨범 사진(A-02, SYSTEM_DESIGN §6.7.2 Album·AlbumItem, ADR 0007). alumni 방에 앨범 하나(사진 목록)입니다.
 * - 파일은 격리 키(`quarantine/<uuid>`)에만 둡니다(수료증과 같은 방식, ADR 0037). worker `album-photo-scan`이 형식 판별·내장 콘텐츠·악성코드
 *   검사 뒤 메타데이터(EXIF·GPS 등)를 지운 내용으로 같은 키를 바꿔 쓰고 clean으로. 산출물 경로로는 내려가지 않습니다.
 * - 원래 파일 이름은 저장하지 않습니다(확장자만). clean 사진만, 방 active 멤버에게만, 그 사람에게만 맞는 짧은 서명 URL로.
 * - 방을 나가도 사진은 방의 기록으로 남고(SYSTEM_DESIGN §6.7.2), 올린 사람 표시는 하지 않습니다. 탈퇴 정리는 그 사람의 사진과 파일을 지웁니다.
 */
export const roomAlbumPhotos = pgTable(
  'room_album_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    caption: text('caption'),
    objectKey: text('object_key').notNull(),
    declaredType: text('declared_type').notNull(),
    fileExtension: text('file_extension').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    scanStatus: scanStatus('scan_status').notNull().default('pending'),
    scanReason: text('scan_reason'),
    scanEngine: text('scan_engine'),
    scanAttempts: integer('scan_attempts').notNull().default(0),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    /** 판별한 형식(검사 통과 뒤). */
    mediaType: text('media_type'),
    /** 메타데이터를 지운 내용이 격리 키에 있는지(clean이면 true). */
    metadataStripped: boolean('metadata_stripped').notNull().default(false),
    /** A-07(ADR 0045): 운영 조치(hide_room_item)로 숨김. 목록·서명 URL에서 빠집니다(올린 사람 포함). */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('room_album_photos_object_key_key').on(t.objectKey),
    index('room_album_photos_space_created_idx').on(t.spaceId, t.createdAt),
    index('room_album_photos_uploader_idx').on(t.uploaderId, t.spaceId),
    check('room_album_photos_object_key_check', sql`${t.objectKey} ~ '^quarantine/[0-9a-f-]{36}$'`),
    check('room_album_photos_extension_check', sql`${t.fileExtension} in ('png', 'jpg', 'jpeg', 'webp')`),
    check('room_album_photos_byte_size_check', sql`${t.byteSize} between 1 and 10485760`),
    check('room_album_photos_sha256_check', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('room_album_photos_caption_check', sql`${t.caption} is null or char_length(${t.caption}) between 1 and 100`),
    check('room_album_photos_clean_check', sql`${t.scanStatus}::text <> 'clean' or (${t.metadataStripped} and ${t.mediaType} is not null)`),
  ],
)

// A-03: 동문회·OB 방의 멤버 명부(ADR 0040). 커뮤니티 구역이므로 C-05·S-02 경계 검사와 social DB 역할 권한 검사가 자동으로 덮습니다
// (social 역할에는 권한을 주지 않음). 공개 프로필·검색·추천·피드·PersonaActivity는 이 테이블을 읽지 않습니다.

/**
 * 멤버 명부 항목(A-03, SYSTEM_DESIGN §6.7.2 DirectoryEntry). **동의한 멤버만 행이 있습니다**: (방, 사람) 하나, 행을 만드는 요청이 곧 동의.
 * - 항목은 모두 선택이고 각각 비울 수 있습니다(interests는 빈 배열). 연락 방법은 자유 글(한 줄)이며 방 멤버 모두에게 보입니다.
 * - 동의 철회·방 나가기·내보내기·탈퇴·익명 방 전환 때 **행을 바로 지웁니다**(설계 초안의 `withdrawn_at`은 두지 않음 — 철회한 사람의 행이
 *   남지 않게, ADR 0040). 그래서 이 표에 있는 행은 모두 지금 동의 중인 항목입니다.
 * - consented_at은 처음 동의한 시각(바꾸기는 updated_at). 철회 뒤 다시 동의하면 새 행이라 새 시각입니다.
 * - 조회는 쪽 단위(최대 20개) + 사용자별 rate limit만 있고, 내보내기·일괄 조회 경로는 없습니다.
 */
export const directoryEntries = pgTable(
  'directory_entries',
  {
    /**
     * A-07(ADR 0045): 신고·조치가 가리키는 항목 id(동의마다 새로 생김 — 철회 뒤 다시 동의하면 새 id). 사용자 id와 무관한 무작위 값이라 다른 방의
     * 항목과 이어지지 않습니다. 기본 키는 그대로 (방, 사람)입니다.
     */
    id: uuid('id').notNull().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => communitySpaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    cohortLabel: text('cohort_label'),
    currentWork: text('current_work'),
    interests: text('interests').array().notNull().default(sql`'{}'::text[]`),
    contactMethod: text('contact_method'),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
    /** A-07(ADR 0045): 운영 조치(hide_room_item)로 숨김. 다른 멤버의 명부에서 빠집니다(본인에게는 "운영 조치로 숨김"). 철회하면 행과 함께 지워집니다. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'directory_entries_pkey', columns: [t.spaceId, t.userId] }),
    uniqueIndex('directory_entries_id_key').on(t.id),
    index('directory_entries_space_consented_idx').on(t.spaceId, t.consentedAt),
    index('directory_entries_user_id_idx').on(t.userId),
    check('directory_entries_cohort_check', sql`${t.cohortLabel} is null or char_length(${t.cohortLabel}) between 1 and 20`),
    check('directory_entries_current_work_check', sql`${t.currentWork} is null or char_length(${t.currentWork}) between 1 and 60`),
    check('directory_entries_interests_check', sql`cardinality(${t.interests}) <= 5`),
    check('directory_entries_contact_check', sql`${t.contactMethod} is null or char_length(${t.contactMethod}) between 1 and 100`),
  ],
)

// A-04: 공감 라운지 미디어(ADR 0041). 커뮤니티 구역이므로 C-05·S-02 경계 검사와 social DB 역할 권한 검사가 자동으로 덮습니다
// (social 역할에는 권한을 주지 않음). 공개 프로필·검색·피드·PersonaActivity·공개 DTO는 이 테이블을 읽지 않습니다.

/**
 * 공감 라운지 글의 미디어(A-04, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 "공감 라운지 미디어", ADR 0041). 지금은 이미지만(영상은 미룸).
 * - 공식 학교 페이지 자유 게시판(공감 라운지) 글에만, 글쓴이 본인만 붙입니다(서비스가 확인). 글 하나에 4개(검사 대기·통과).
 * - 파일은 격리 키(`quarantine/<uuid>`)에만 둡니다(앨범 사진과 같은 방식, ADR 0039). worker `post-media-scan`이 형식 판별·내장 콘텐츠·악성코드
 *   검사 뒤 메타데이터(EXIF·GPS 등)를 지운 내용으로 같은 키를 바꿔 쓰고 clean으로. 원래 파일 이름은 저장하지 않습니다(확장자만).
 * - 보는 것은 **그 글을 읽을 수 있는 사람**에게, 그 사람에게만 맞는 짧은 서명 URL로. 글이 게시 중이 아니면(가림·지움) 404.
 * - 글쓴이가 글을 지우면 worker 정리가 행과 파일을 지웁니다(가린 글은 이의제기로 되돌릴 수 있게 남김). 탈퇴 정리는 그 사람의 미디어를 모두 지웁니다.
 */
export const communityPostMedia = pgTable(
  'community_post_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => communityPosts.id),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    objectKey: text('object_key').notNull(),
    declaredType: text('declared_type').notNull(),
    fileExtension: text('file_extension').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    scanStatus: scanStatus('scan_status').notNull().default('pending'),
    scanReason: text('scan_reason'),
    scanEngine: text('scan_engine'),
    scanAttempts: integer('scan_attempts').notNull().default(0),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    /** 판별한 형식(검사 통과 뒤). */
    mediaType: text('media_type'),
    /** 메타데이터를 지운 내용이 격리 키에 있는지(clean이면 true). */
    metadataStripped: boolean('metadata_stripped').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('community_post_media_object_key_key').on(t.objectKey),
    index('community_post_media_post_created_idx').on(t.postId, t.createdAt),
    index('community_post_media_uploader_idx').on(t.uploaderId),
    check('community_post_media_object_key_check', sql`${t.objectKey} ~ '^quarantine/[0-9a-f-]{36}$'`),
    check('community_post_media_extension_check', sql`${t.fileExtension} in ('png', 'jpg', 'jpeg', 'webp')`),
    check('community_post_media_byte_size_check', sql`${t.byteSize} between 1 and 10485760`),
    check('community_post_media_sha256_check', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('community_post_media_clean_check', sql`${t.scanStatus}::text <> 'clean' or (${t.metadataStripped} and ${t.mediaType} is not null)`),
  ],
)
