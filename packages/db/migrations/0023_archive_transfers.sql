CREATE TYPE "public"."archive_transfer_status" AS ENUM('awaiting_consent', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."archive_transfer_target" AS ENUM('course_qa', 'stuck_log', 'senior_note');--> statement-breakpoint
CREATE TYPE "public"."course_qa_status" AS ENUM('published', 'withdrawn', 'hidden');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'archive_transfer_requested';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'archive_transfer_completed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'course_qa_published';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'archive_consent_requested';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'archive_transfer_done';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'archive_transfer_cancelled';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_qa';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'course_qa';--> statement-breakpoint
ALTER TYPE "public"."search_doc_kind" ADD VALUE 'qa';--> statement-breakpoint
ALTER TYPE "public"."signal_target_kind" ADD VALUE 'course_qa';--> statement-breakpoint
CREATE TABLE "archive_transfer_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"display_mode" "community_name_mode",
	"display_label" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "archive_transfer_consents_role_check" CHECK ("archive_transfer_consents"."role" in ('asker', 'answerer', 'author')),
	CONSTRAINT "archive_transfer_consents_status_check" CHECK ("archive_transfer_consents"."status" in ('pending', 'granted', 'declined')),
	CONSTRAINT "archive_transfer_consents_decided_check" CHECK (("archive_transfer_consents"."status" = 'pending') = ("archive_transfer_consents"."decided_at" is null)),
	CONSTRAINT "archive_transfer_consents_granted_check" CHECK ("archive_transfer_consents"."status" <> 'granted' or "archive_transfer_consents"."content_hash" is not null),
	CONSTRAINT "archive_transfer_consents_label_check" CHECK ("archive_transfer_consents"."display_label" is null or char_length("archive_transfer_consents"."display_label") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "archive_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" "archive_transfer_target" NOT NULL,
	"status" "archive_transfer_status" DEFAULT 'awaiting_consent' NOT NULL,
	"space_id" uuid NOT NULL,
	"source_post_id" uuid NOT NULL,
	"source_comment_id" uuid,
	"initiator_id" uuid NOT NULL,
	"course_id" uuid,
	"project_id" uuid,
	"time_bucket" text,
	"snapshot" jsonb,
	"content_hash" text NOT NULL,
	"cancel_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"course_qa_item_id" uuid,
	"senior_note_id" uuid,
	"stuck_log_id" uuid,
	"solution_log_id" uuid,
	CONSTRAINT "archive_transfers_hash_check" CHECK ("archive_transfers"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "archive_transfers_status_check" CHECK (("archive_transfers"."status"::text = 'awaiting_consent' and "archive_transfers"."completed_at" is null and "archive_transfers"."cancelled_at" is null and "archive_transfers"."snapshot" is not null)
        or ("archive_transfers"."status"::text = 'done' and "archive_transfers"."completed_at" is not null and "archive_transfers"."cancelled_at" is null and "archive_transfers"."snapshot" is null)
        or ("archive_transfers"."status"::text = 'cancelled' and "archive_transfers"."cancelled_at" is not null and "archive_transfers"."completed_at" is null and "archive_transfers"."snapshot" is null and "archive_transfers"."cancel_reason" is not null)),
	CONSTRAINT "archive_transfers_cancel_reason_check" CHECK ("archive_transfers"."cancel_reason" is null or "archive_transfers"."cancel_reason" in ('cancelled_by_initiator', 'declined', 'expired', 'source_unavailable', 'answer_changed', 'account_deleted', 'target_unavailable')),
	CONSTRAINT "archive_transfers_target_check" CHECK (("archive_transfers"."target"::text = 'course_qa' and "archive_transfers"."course_id" is not null and "archive_transfers"."project_id" is null and "archive_transfers"."source_comment_id" is not null)
        or ("archive_transfers"."target"::text = 'stuck_log' and "archive_transfers"."project_id" is not null and "archive_transfers"."course_id" is null and "archive_transfers"."time_bucket" is not null)
        or ("archive_transfers"."target"::text = 'senior_note' and "archive_transfers"."course_id" is not null and "archive_transfers"."project_id" is null and "archive_transfers"."source_comment_id" is null)),
	CONSTRAINT "archive_transfers_result_check" CHECK ("archive_transfers"."status"::text <> 'done'
        or ("archive_transfers"."target"::text = 'course_qa' and "archive_transfers"."course_qa_item_id" is not null)
        or ("archive_transfers"."target"::text = 'stuck_log' and "archive_transfers"."stuck_log_id" is not null)
        or ("archive_transfers"."target"::text = 'senior_note' and "archive_transfers"."senior_note_id" is not null)),
	CONSTRAINT "archive_transfers_time_bucket_check" CHECK ("archive_transfers"."time_bucket" is null or "archive_transfers"."time_bucket" in ('lt30m', 'lt2h', 'half_day', 'day_plus'))
);
--> statement-breakpoint
CREATE TABLE "course_qa_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"question_title" text NOT NULL,
	"question_body" text NOT NULL,
	"answer_body" text NOT NULL,
	"asker_label" text NOT NULL,
	"asker_anonymous" boolean NOT NULL,
	"answerer_label" text NOT NULL,
	"answerer_anonymous" boolean NOT NULL,
	"asker_id" uuid,
	"answerer_id" uuid,
	"status" "course_qa_status" DEFAULT 'published' NOT NULL,
	"transfer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	CONSTRAINT "course_qa_items_transfer_id_unique" UNIQUE("transfer_id"),
	CONSTRAINT "course_qa_items_content_check" CHECK ((char_length("course_qa_items"."question_title") between 1 and 120 and char_length("course_qa_items"."question_body") between 1 and 10000 and char_length("course_qa_items"."answer_body") between 1 and 3000)
        or ("course_qa_items"."status"::text = 'withdrawn' and "course_qa_items"."question_title" = '' and "course_qa_items"."question_body" = '' and "course_qa_items"."answer_body" = '')),
	CONSTRAINT "course_qa_items_labels_check" CHECK (char_length("course_qa_items"."asker_label") between 1 and 40 and char_length("course_qa_items"."answerer_label") between 1 and 40),
	CONSTRAINT "course_qa_items_withdrawn_check" CHECK (("course_qa_items"."status"::text = 'withdrawn') = ("course_qa_items"."withdrawn_at" is not null)),
	CONSTRAINT "course_qa_items_withdrawn_by_check" CHECK ("course_qa_items"."withdrawn_by" is null or "course_qa_items"."withdrawn_by" in ('asker', 'answerer', 'account_deleted'))
);
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "search_documents" DROP CONSTRAINT "search_documents_target_check";--> statement-breakpoint
ALTER TABLE "usefulness_signals" DROP CONSTRAINT "usefulness_signals_target_check";--> statement-breakpoint
ALTER TABLE "community_notices" ADD COLUMN "archive_transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "accepted_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "course_qa_item_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "course_qa_item_id" uuid;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "course_qa_item_id" uuid;--> statement-breakpoint
ALTER TABLE "usefulness_signals" ADD COLUMN "course_qa_item_id" uuid;--> statement-breakpoint
ALTER TABLE "archive_transfer_consents" ADD CONSTRAINT "archive_transfer_consents_transfer_id_archive_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."archive_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfer_consents" ADD CONSTRAINT "archive_transfer_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_source_post_id_community_posts_id_fk" FOREIGN KEY ("source_post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_source_comment_id_community_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_course_qa_item_id_course_qa_items_id_fk" FOREIGN KEY ("course_qa_item_id") REFERENCES "public"."course_qa_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_senior_note_id_senior_notes_id_fk" FOREIGN KEY ("senior_note_id") REFERENCES "public"."senior_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_stuck_log_id_log_entries_id_fk" FOREIGN KEY ("stuck_log_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_transfers" ADD CONSTRAINT "archive_transfers_solution_log_id_log_entries_id_fk" FOREIGN KEY ("solution_log_id") REFERENCES "public"."log_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_qa_items" ADD CONSTRAINT "course_qa_items_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_qa_items" ADD CONSTRAINT "course_qa_items_asker_id_users_id_fk" FOREIGN KEY ("asker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_qa_items" ADD CONSTRAINT "course_qa_items_answerer_id_users_id_fk" FOREIGN KEY ("answerer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_transfer_consents_transfer_user_key" ON "archive_transfer_consents" USING btree ("transfer_id","user_id");--> statement-breakpoint
CREATE INDEX "archive_transfer_consents_user_idx" ON "archive_transfer_consents" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_transfers_open_key" ON "archive_transfers" USING btree ("source_post_id","target") WHERE "archive_transfers"."completed_at" is null and "archive_transfers"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "archive_transfers_post_idx" ON "archive_transfers" USING btree ("source_post_id");--> statement-breakpoint
CREATE INDEX "archive_transfers_comment_idx" ON "archive_transfers" USING btree ("source_comment_id");--> statement-breakpoint
CREATE INDEX "archive_transfers_initiator_idx" ON "archive_transfers" USING btree ("initiator_id","created_at");--> statement-breakpoint
CREATE INDEX "course_qa_items_course_published_idx" ON "course_qa_items" USING btree ("course_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "course_qa_items_asker_idx" ON "course_qa_items" USING btree ("asker_id");--> statement-breakpoint
CREATE INDEX "course_qa_items_answerer_idx" ON "course_qa_items" USING btree ("answerer_id");--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_archive_transfer_id_archive_transfers_id_fk" FOREIGN KEY ("archive_transfer_id") REFERENCES "public"."archive_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_accepted_comment_id_community_comments_id_fk" FOREIGN KEY ("accepted_comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_course_qa_item_id_course_qa_items_id_fk" FOREIGN KEY ("course_qa_item_id") REFERENCES "public"."course_qa_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_course_qa_item_id_course_qa_items_id_fk" FOREIGN KEY ("course_qa_item_id") REFERENCES "public"."course_qa_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_course_qa_item_id_course_qa_items_id_fk" FOREIGN KEY ("course_qa_item_id") REFERENCES "public"."course_qa_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usefulness_signals" ADD CONSTRAINT "usefulness_signals_course_qa_item_id_course_qa_items_id_fk" FOREIGN KEY ("course_qa_item_id") REFERENCES "public"."course_qa_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_notices_transfer_kind_user_key" ON "community_notices" USING btree ("archive_transfer_id","kind","user_id") WHERE "community_notices"."archive_transfer_id" is not null;--> statement-breakpoint
CREATE INDEX "moderation_actions_course_qa_idx" ON "moderation_actions" USING btree ("course_qa_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_qa_key" ON "search_documents" USING btree ("course_qa_item_id") WHERE "search_documents"."course_qa_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "usefulness_signals_qa_key" ON "usefulness_signals" USING btree ("user_id","course_qa_item_id","kind") WHERE "usefulness_signals"."course_qa_item_id" is not null;--> statement-breakpoint
CREATE INDEX "usefulness_signals_qa_idx" ON "usefulness_signals" USING btree ("course_qa_item_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_course_qa_check" CHECK ("moderation_actions"."kind"::text <> 'hide_qa' or "moderation_actions"."course_qa_item_id" is not null);--> statement-breakpoint
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
        or ("reports"."target_type"::text = 'course_qa' and "reports"."course_qa_item_id" is not null));--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_target_check" CHECK (("search_documents"."kind" in ('case', 'stuck') and "search_documents"."publication_id" is not null and "search_documents"."release_id" is not null and "search_documents"."senior_note_id" is null
          and (("search_documents"."kind" = 'case') = ("search_documents"."item_key" is null)))
        or ("search_documents"."kind" = 'note' and "search_documents"."senior_note_id" is not null and "search_documents"."note_version" is not null and "search_documents"."publication_id" is null and "search_documents"."release_id" is null)
        or ("search_documents"."kind"::text = 'qa' and "search_documents"."course_qa_item_id" is not null and "search_documents"."publication_id" is null and "search_documents"."release_id" is null and "search_documents"."senior_note_id" is null));--> statement-breakpoint
ALTER TABLE "usefulness_signals" ADD CONSTRAINT "usefulness_signals_target_check" CHECK (("usefulness_signals"."target_kind" = 'stuck_item' and "usefulness_signals"."publication_id" is not null and "usefulness_signals"."item_key" is not null and "usefulness_signals"."senior_note_id" is null and "usefulness_signals"."course_qa_item_id" is null)
        or ("usefulness_signals"."target_kind" = 'senior_note' and "usefulness_signals"."senior_note_id" is not null and "usefulness_signals"."publication_id" is null and "usefulness_signals"."item_key" is null and "usefulness_signals"."course_qa_item_id" is null)
        or ("usefulness_signals"."target_kind"::text = 'course_qa' and "usefulness_signals"."course_qa_item_id" is not null and "usefulness_signals"."publication_id" is null and "usefulness_signals"."item_key" is null and "usefulness_signals"."senior_note_id" is null));