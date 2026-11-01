-- A-06 현직자 답변 이동·수료 회고(ADR 0043).
-- 1) 토픽 답변 → 선배 노트: senior_note_display_mode에 affiliation(소속 표시 유지), senior_notes.affiliation_label(원 글의 고정된 소속 표시를 복사),
--    archive_transfers의 senior_note가 댓글(source_comment_id)을 원본으로 가질 수 있음.
-- 2) 수료 회고: completion_retros(별점·연봉·추천 점수 열 없음) + 신고 대상 completion_retro·조치 hide_retro.
-- drizzle migrate는 처음부터 돌릴 때 모든 migration을 한 트랜잭션에서 실행하고, PostgreSQL은 ADD VALUE한 enum 값을 같은 트랜잭션에서 쓸 수 없습니다.
-- 그래서 ADD VALUE한 값(affiliation·completion_retro·hide_retro)을 쓰는 check·트리거는 모두 `::text`로 비교합니다. 새로 만든 enum(completion_retro_*)은
-- 같은 트랜잭션에서 써도 됩니다. 페르소나 투영 함수(persona_activity_source_ok, 0031)는 senior_note를 name·display만 허용하므로 고치지 않아도
-- affiliation 노트의 투영 경로가 없습니다.
CREATE TYPE "public"."completion_retro_display_mode" AS ENUM('name', 'display', 'anonymous');--> statement-breakpoint
CREATE TYPE "public"."completion_retro_status" AS ENUM('published', 'withdrawn', 'hidden');--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_retro';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'completion_retro';--> statement-breakpoint
ALTER TYPE "public"."senior_note_display_mode" ADD VALUE 'affiliation';--> statement-breakpoint
CREATE TABLE "completion_retros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"cohort_id" uuid,
	"author_id" uuid NOT NULL,
	"display_mode" "completion_retro_display_mode" NOT NULL,
	"display_name_snapshot" text,
	"label_scope_requested" "affiliation_label_scope" NOT NULL,
	"label_scope_applied" "affiliation_label_scope" NOT NULL,
	"institution_label" text,
	"cohort_label" text,
	"answers" jsonb NOT NULL,
	"guidelines_confirmed" boolean NOT NULL,
	"status" "completion_retro_status" DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "completion_retros_answers_object_check" CHECK (jsonb_typeof("completion_retros"."answers") = 'object'),
	CONSTRAINT "completion_retros_confirmed_check" CHECK ("completion_retros"."guidelines_confirmed"),
	CONSTRAINT "completion_retros_display_name_check" CHECK (("completion_retros"."display_mode" = 'anonymous') = ("completion_retros"."display_name_snapshot" is null)
        and ("completion_retros"."display_name_snapshot" is null or char_length("completion_retros"."display_name_snapshot") between 1 and 80)),
	CONSTRAINT "completion_retros_label_scope_check" CHECK ("completion_retros"."label_scope_applied" = "completion_retros"."label_scope_requested"
        or ("completion_retros"."label_scope_requested" = 'institution' and "completion_retros"."label_scope_applied" in ('institution_kind', 'none'))
        or ("completion_retros"."label_scope_requested" = 'institution_kind' and "completion_retros"."label_scope_applied" = 'none')),
	CONSTRAINT "completion_retros_named_scope_check" CHECK ("completion_retros"."display_mode" = 'anonymous' or ("completion_retros"."label_scope_requested" = 'institution' and "completion_retros"."label_scope_applied" = 'institution')),
	CONSTRAINT "completion_retros_institution_label_check" CHECK (("completion_retros"."label_scope_applied" = 'none') = ("completion_retros"."institution_label" is null)
        and ("completion_retros"."institution_label" is null or char_length("completion_retros"."institution_label") between 1 and 100)),
	CONSTRAINT "completion_retros_cohort_label_check" CHECK ("completion_retros"."cohort_label" is null or ("completion_retros"."display_mode" <> 'anonymous' and char_length("completion_retros"."cohort_label") between 1 and 20)),
	CONSTRAINT "completion_retros_withdrawn_check" CHECK ("completion_retros"."status" <> 'withdrawn' or "completion_retros"."withdrawn_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "archive_transfers" DROP CONSTRAINT "archive_transfers_target_check";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "completion_retro_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "completion_retro_id" uuid;--> statement-breakpoint
ALTER TABLE "senior_notes" ADD COLUMN "affiliation_label" text;--> statement-breakpoint
ALTER TABLE "completion_retros" ADD CONSTRAINT "completion_retros_institution_id_schools_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_retros" ADD CONSTRAINT "completion_retros_cohort_id_institution_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."institution_cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_retros" ADD CONSTRAINT "completion_retros_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "completion_retros_institution_published_idx" ON "completion_retros" USING btree ("institution_id","published_at" DESC NULLS LAST) WHERE "completion_retros"."status" = 'published';--> statement-breakpoint
CREATE INDEX "completion_retros_published_idx" ON "completion_retros" USING btree ("published_at" DESC NULLS LAST) WHERE "completion_retros"."status" = 'published';--> statement-breakpoint
CREATE INDEX "completion_retros_author_idx" ON "completion_retros" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "completion_retros_cohort_idx" ON "completion_retros" USING btree ("cohort_id");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_retros_author_institution_open_key" ON "completion_retros" USING btree ("author_id","institution_id") WHERE "completion_retros"."status" in ('published', 'hidden');--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_completion_retro_id_completion_retros_id_fk" FOREIGN KEY ("completion_retro_id") REFERENCES "public"."completion_retros"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_completion_retro_id_completion_retros_id_fk" FOREIGN KEY ("completion_retro_id") REFERENCES "public"."completion_retros"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_completion_retro_idx" ON "moderation_actions" USING btree ("completion_retro_id");--> statement-breakpoint
CREATE INDEX "reports_completion_retro_idx" ON "reports" USING btree ("completion_retro_id");--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_target_check" CHECK (("archive_transfers"."target"::text = 'course_qa' and "archive_transfers"."course_id" is not null and "archive_transfers"."project_id" is null and "archive_transfers"."source_comment_id" is not null)
        or ("archive_transfers"."target"::text = 'stuck_log' and "archive_transfers"."project_id" is not null and "archive_transfers"."course_id" is null and "archive_transfers"."time_bucket" is not null)
        or ("archive_transfers"."target"::text = 'senior_note' and "archive_transfers"."course_id" is not null and "archive_transfers"."project_id" is null));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_completion_retro_check" CHECK ("moderation_actions"."kind"::text <> 'hide_retro' or "moderation_actions"."completion_retro_id" is not null);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_check" CHECK (("reports"."target_type" = 'publication' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is null)
        or ("reports"."target_type" = 'publication_item' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is not null and "reports"."item_key" is not null)
        or ("reports"."target_type" = 'senior_note' and "reports"."senior_note_id" is not null and "reports"."note_version" is not null)
        or ("reports"."target_type" = 'case_study' and "reports"."case_study_id" is not null and "reports"."case_study_version" is not null)
        or ("reports"."target_type" = 'profile' and "reports"."profile_user_id" is not null)
        or ("reports"."target_type"::text = 'community_space' and "reports"."community_space_id" is not null)
        or ("reports"."target_type"::text = 'community_post' and "reports"."community_post_id" is not null)
        or ("reports"."target_type"::text = 'community_comment' and "reports"."community_comment_id" is not null)
        or ("reports"."target_type"::text = 'community_recruitment' and "reports"."community_recruitment_id" is not null)
        or ("reports"."target_type"::text = 'community_application' and "reports"."community_application_id" is not null)
        or ("reports"."target_type"::text = 'course_qa' and "reports"."course_qa_item_id" is not null)
        or ("reports"."target_type"::text = 'persona' and "reports"."persona_id" is not null)
        or ("reports"."target_type"::text = 'profile_post' and "reports"."profile_post_id" is not null)
        or ("reports"."target_type"::text = 'social_link' and "reports"."social_link_id" is not null)
        or ("reports"."target_type"::text = 'completion_retro' and "reports"."completion_retro_id" is not null));--> statement-breakpoint
ALTER TABLE "senior_notes" ADD CONSTRAINT "senior_notes_affiliation_label_check" CHECK (("senior_notes"."affiliation_label" is null or char_length("senior_notes"."affiliation_label") between 1 and 100)
        and ("senior_notes"."display_mode"::text <> 'affiliation' or ("senior_notes"."affiliation_label" is not null and "senior_notes"."display_name_snapshot" is null)));--> statement-breakpoint
-- 아래는 drizzle 스키마가 표현하지 못해 손으로 둔 SQL입니다(스냅샷과 무관).
-- 3) 선배 노트의 복사한 소속 표시는 고정입니다: 다른 값으로 바꿀 수 없고 null로 비우는 것(탈퇴 정리)만 됩니다(다시 계산하지 않음).
CREATE FUNCTION "public"."senior_notes_affiliation_label_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.affiliation_label IS DISTINCT FROM OLD.affiliation_label AND NEW.affiliation_label IS NOT NULL THEN
    RAISE EXCEPTION 'senior_notes.affiliation_label is frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "senior_notes_affiliation_label_guard" BEFORE UPDATE OF "affiliation_label" ON "senior_notes" FOR EACH ROW EXECUTE FUNCTION "public"."senior_notes_affiliation_label_guard"();--> statement-breakpoint
-- 4) 수료 회고의 기관·작성자·기관 표시는 쓰는 순간 고정입니다. 이름(방식·사본·기수)은 익명·빈 값으로 바꾸는 것(탈퇴 정리)만 됩니다.
CREATE FUNCTION "public"."completion_retros_frozen_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.institution_id IS DISTINCT FROM OLD.institution_id OR NEW.author_id IS DISTINCT FROM OLD.author_id
    OR NEW.label_scope_requested IS DISTINCT FROM OLD.label_scope_requested OR NEW.label_scope_applied IS DISTINCT FROM OLD.label_scope_applied
    OR NEW.institution_label IS DISTINCT FROM OLD.institution_label OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'completion_retros: frozen columns cannot change' USING ERRCODE = '23514';
  END IF;
  IF (NEW.display_mode IS DISTINCT FROM OLD.display_mode AND NEW.display_mode::text <> 'anonymous')
    OR (NEW.display_name_snapshot IS DISTINCT FROM OLD.display_name_snapshot AND NEW.display_name_snapshot IS NOT NULL)
    OR (NEW.cohort_label IS DISTINCT FROM OLD.cohort_label AND NEW.cohort_label IS NOT NULL)
    OR (NEW.cohort_id IS DISTINCT FROM OLD.cohort_id AND NEW.cohort_id IS NOT NULL) THEN
    RAISE EXCEPTION 'completion_retros: name columns can only be cleared' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "completion_retros_frozen_guard" BEFORE UPDATE ON "completion_retros" FOR EACH ROW EXECUTE FUNCTION "public"."completion_retros_frozen_guard"();
