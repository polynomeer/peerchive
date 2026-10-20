CREATE TYPE "public"."appeal_status" AS ENUM('open', 'upheld', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."hidden_item_kind" AS ENUM('log', 'claim', 'artifact');--> statement-breakpoint
CREATE TYPE "public"."moderation_action_kind" AS ENUM('none', 'restrict', 'hide_item', 'hide_note', 'hide_case_study', 'hide_profile');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('personal_info', 'answer_sharing', 'copyright', 'harassment', 'false_claim', 'spam', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'in_review', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('publication', 'publication_item', 'senior_note', 'case_study', 'profile');--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"appellant_id" uuid NOT NULL,
	"message" text NOT NULL,
	"status" "appeal_status" DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeals_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "appeals_message_check" CHECK (char_length("appeals"."message") between 1 and 1000),
	CONSTRAINT "appeals_decision_note_check" CHECK ("appeals"."decision_note" is null or char_length("appeals"."decision_note") between 1 and 1000),
	CONSTRAINT "appeals_decided_check" CHECK (("appeals"."status" = 'open') = ("appeals"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"created_by_report_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	CONSTRAINT "holds_created_by_report_id_unique" UNIQUE("created_by_report_id"),
	CONSTRAINT "holds_reason_check" CHECK ("holds"."reason" in ('personal_info', 'copyright'))
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "moderation_action_kind" NOT NULL,
	"outcome" text NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_key" text NOT NULL,
	"publication_id" uuid,
	"release_id" uuid,
	"item_kind" "hidden_item_kind",
	"item_key" text,
	"senior_note_id" uuid,
	"case_study_id" uuid,
	"profile_user_id" uuid,
	"internal_note" text NOT NULL,
	"public_reason" text,
	"notify_owner" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reverse_note" text,
	"reverse_cause" text,
	CONSTRAINT "moderation_actions_outcome_check" CHECK ("moderation_actions"."outcome" in ('resolved', 'dismissed') and ("moderation_actions"."outcome" = 'resolved' or "moderation_actions"."kind" = 'none')),
	CONSTRAINT "moderation_actions_internal_note_check" CHECK (char_length("moderation_actions"."internal_note") between 1 and 1000),
	CONSTRAINT "moderation_actions_public_reason_check" CHECK ("moderation_actions"."public_reason" is null or char_length("moderation_actions"."public_reason") between 1 and 300),
	CONSTRAINT "moderation_actions_reverse_note_check" CHECK ("moderation_actions"."reverse_note" is null or char_length("moderation_actions"."reverse_note") between 1 and 1000),
	CONSTRAINT "moderation_actions_reversed_check" CHECK (("moderation_actions"."reversed_at" is null) = ("moderation_actions"."reverse_cause" is null) and ("moderation_actions"."reverse_cause" is null or "moderation_actions"."reverse_cause" in ('lift', 'appeal')) and ("moderation_actions"."reversed_at" is null or "moderation_actions"."kind" <> 'none')),
	CONSTRAINT "moderation_actions_item_check" CHECK (("moderation_actions"."kind" <> 'hide_item') or ("moderation_actions"."item_kind" is not null and "moderation_actions"."item_key" is not null and "moderation_actions"."publication_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "release_hidden_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"item_kind" "hidden_item_kind" NOT NULL,
	"item_key" text NOT NULL,
	"action_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	CONSTRAINT "release_hidden_items_key_check" CHECK (char_length("release_hidden_items"."item_key") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_key" text NOT NULL,
	"publication_id" uuid,
	"release_id" uuid,
	"item_kind" "hidden_item_kind",
	"item_key" text,
	"senior_note_id" uuid,
	"note_version" integer,
	"case_study_id" uuid,
	"case_study_version" integer,
	"profile_user_id" uuid,
	"reason" "report_reason" NOT NULL,
	"details" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"assigned_at" timestamp with time zone,
	"action_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_details_check" CHECK ("reports"."details" is null or char_length("reports"."details") between 1 and 1000),
	CONSTRAINT "reports_closed_check" CHECK (("reports"."status" in ('resolved', 'dismissed')) = ("reports"."closed_at" is not null and "reports"."action_id" is not null)),
	CONSTRAINT "reports_item_key_check" CHECK ("reports"."item_key" is null or char_length("reports"."item_key") between 1 and 64),
	CONSTRAINT "reports_target_check" CHECK (("reports"."target_type" = 'publication' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is null)
        or ("reports"."target_type" = 'publication_item' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is not null and "reports"."item_key" is not null)
        or ("reports"."target_type" = 'senior_note' and "reports"."senior_note_id" is not null and "reports"."note_version" is not null)
        or ("reports"."target_type" = 'case_study' and "reports"."case_study_id" is not null and "reports"."case_study_version" is not null)
        or ("reports"."target_type" = 'profile' and "reports"."profile_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "case_studies" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_action_id_moderation_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_appellant_id_users_id_fk" FOREIGN KEY ("appellant_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_created_by_report_id_reports_id_fk" FOREIGN KEY ("created_by_report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_release_id_publication_candidates_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_senior_note_id_senior_notes_id_fk" FOREIGN KEY ("senior_note_id") REFERENCES "public"."senior_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_case_study_id_case_studies_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_profile_user_id_users_id_fk" FOREIGN KEY ("profile_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_hidden_items" ADD CONSTRAINT "release_hidden_items_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_hidden_items" ADD CONSTRAINT "release_hidden_items_release_id_publication_candidates_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_hidden_items" ADD CONSTRAINT "release_hidden_items_action_id_moderation_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_release_id_publication_candidates_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."publication_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_senior_note_id_senior_notes_id_fk" FOREIGN KEY ("senior_note_id") REFERENCES "public"."senior_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_study_id_case_studies_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_profile_user_id_users_id_fk" FOREIGN KEY ("profile_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_action_id_moderation_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appeals_status_created_idx" ON "appeals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "holds_open_publication_idx" ON "holds" USING btree ("publication_id") WHERE "holds"."released_at" is null;--> statement-breakpoint
CREATE INDEX "moderation_actions_target_key_idx" ON "moderation_actions" USING btree ("target_key","created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_publication_idx" ON "moderation_actions" USING btree ("publication_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_senior_note_idx" ON "moderation_actions" USING btree ("senior_note_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_case_study_idx" ON "moderation_actions" USING btree ("case_study_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_profile_user_idx" ON "moderation_actions" USING btree ("profile_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_hidden_items_active_key" ON "release_hidden_items" USING btree ("publication_id","item_kind","item_key") WHERE "release_hidden_items"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "release_hidden_items_action_idx" ON "release_hidden_items" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_reporter_target_key" ON "reports" USING btree ("reporter_id","target_key") WHERE "reports"."status" in ('open', 'in_review');--> statement-breakpoint
CREATE INDEX "reports_target_key_idx" ON "reports" USING btree ("target_key","status");--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_id","created_at");