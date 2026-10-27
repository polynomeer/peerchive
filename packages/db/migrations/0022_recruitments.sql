CREATE TYPE "public"."application_status" AS ENUM('pending', 'accepted', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."recruitment_kind" AS ENUM('team', 'study');--> statement-breakpoint
CREATE TYPE "public"."recruitment_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'recruitment_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'application_submitted';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'recruitment_closed';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'recruitment_invited';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'recruitment_not_selected';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'recruitment_cancelled';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_recruitment';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'hide_application';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'community_recruitment';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'community_application';--> statement-breakpoint
CREATE TABLE "recruitment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recruitment_id" uuid NOT NULL,
	"applicant_id" uuid NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"profile_handle" text,
	"case_slugs" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"project_invitation_id" uuid,
	"space_invitation_id" uuid,
	"message_hidden_at" timestamp with time zone,
	CONSTRAINT "recruitment_applications_message_check" CHECK (char_length("recruitment_applications"."message") <= 500),
	CONSTRAINT "recruitment_applications_cases_check" CHECK (cardinality("recruitment_applications"."case_slugs") <= 3),
	CONSTRAINT "recruitment_applications_handle_check" CHECK ("recruitment_applications"."profile_handle" is null or "recruitment_applications"."profile_handle" ~ '^[a-z0-9-]{3,30}$'),
	CONSTRAINT "recruitment_applications_decided_check" CHECK (("recruitment_applications"."status"::text = 'pending') = ("recruitment_applications"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "recruitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "recruitment_kind" NOT NULL,
	"space_id" uuid,
	"course_id" uuid,
	"term_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"capacity" integer NOT NULL,
	"room_name_mode" "community_name_mode",
	"status" "recruitment_status" DEFAULT 'open' NOT NULL,
	"closes_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"result_project_id" uuid,
	"result_space_id" uuid,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "recruitments_host_check" CHECK ("recruitments"."space_id" is not null or "recruitments"."course_id" is not null),
	CONSTRAINT "recruitments_team_course_check" CHECK ("recruitments"."kind"::text <> 'team' or "recruitments"."course_id" is not null),
	CONSTRAINT "recruitments_term_course_check" CHECK ("recruitments"."term_id" is null or "recruitments"."course_id" is not null),
	CONSTRAINT "recruitments_room_name_mode_check" CHECK (("recruitments"."kind"::text = 'study') = ("recruitments"."room_name_mode" is not null)),
	CONSTRAINT "recruitments_capacity_check" CHECK ("recruitments"."capacity" between 2 and 20),
	CONSTRAINT "recruitments_title_check" CHECK (char_length("recruitments"."title") between 1 and 80 or ("recruitments"."status"::text <> 'open' and "recruitments"."title" = '' and "recruitments"."description" = '')),
	CONSTRAINT "recruitments_description_check" CHECK (char_length("recruitments"."description") <= 2000),
	CONSTRAINT "recruitments_closed_check" CHECK (("recruitments"."status"::text = 'open') = ("recruitments"."closed_at" is null)),
	CONSTRAINT "recruitments_result_project_check" CHECK ("recruitments"."result_project_id" is null or ("recruitments"."kind"::text = 'team' and "recruitments"."status"::text = 'closed')),
	CONSTRAINT "recruitments_result_space_check" CHECK ("recruitments"."result_space_id" is null or ("recruitments"."kind"::text = 'study' and "recruitments"."status"::text = 'closed'))
);
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "community_notices" ALTER COLUMN "space_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "community_notices" ADD COLUMN "recruitment_id" uuid;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "team_finding_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "community_recruitment_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "community_application_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "community_recruitment_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "community_application_id" uuid;--> statement-breakpoint
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_recruitment_id_recruitments_id_fk" FOREIGN KEY ("recruitment_id") REFERENCES "public"."recruitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_project_invitation_id_invitations_id_fk" FOREIGN KEY ("project_invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_space_invitation_id_space_invitations_id_fk" FOREIGN KEY ("space_invitation_id") REFERENCES "public"."space_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitments" ADD CONSTRAINT "recruitments_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitments" ADD CONSTRAINT "recruitments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitments" ADD CONSTRAINT "recruitments_term_id_course_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."course_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitments" ADD CONSTRAINT "recruitments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitments" ADD CONSTRAINT "recruitments_result_project_id_projects_id_fk" FOREIGN KEY ("result_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitments" ADD CONSTRAINT "recruitments_result_space_id_community_spaces_id_fk" FOREIGN KEY ("result_space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recruitment_applications_recruitment_applicant_key" ON "recruitment_applications" USING btree ("recruitment_id","applicant_id");--> statement-breakpoint
CREATE INDEX "recruitment_applications_recruitment_created_idx" ON "recruitment_applications" USING btree ("recruitment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "recruitment_applications_applicant_idx" ON "recruitment_applications" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "recruitments_space_created_idx" ON "recruitments" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "recruitments_course_created_idx" ON "recruitments" USING btree ("course_id","created_at");--> statement-breakpoint
CREATE INDEX "recruitments_created_by_idx" ON "recruitments" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_recruitment_id_recruitments_id_fk" FOREIGN KEY ("recruitment_id") REFERENCES "public"."recruitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_community_recruitment_id_recruitments_id_fk" FOREIGN KEY ("community_recruitment_id") REFERENCES "public"."recruitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_community_application_id_recruitment_applications_id_fk" FOREIGN KEY ("community_application_id") REFERENCES "public"."recruitment_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_community_recruitment_id_recruitments_id_fk" FOREIGN KEY ("community_recruitment_id") REFERENCES "public"."recruitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_community_application_id_recruitment_applications_id_fk" FOREIGN KEY ("community_application_id") REFERENCES "public"."recruitment_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_notices_recruitment_kind_user_key" ON "community_notices" USING btree ("recruitment_id","kind","user_id") WHERE "community_notices"."recruitment_id" is not null;--> statement-breakpoint
CREATE INDEX "moderation_actions_community_recruitment_idx" ON "moderation_actions" USING btree ("community_recruitment_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_community_application_idx" ON "moderation_actions" USING btree ("community_application_id");--> statement-breakpoint
ALTER TABLE "community_notices" ADD CONSTRAINT "community_notices_subject_check" CHECK ("community_notices"."space_id" is not null or "community_notices"."recruitment_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_recruitment_check" CHECK ("moderation_actions"."kind"::text <> 'hide_recruitment' or "moderation_actions"."community_recruitment_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_application_check" CHECK ("moderation_actions"."kind"::text <> 'hide_application' or "moderation_actions"."community_application_id" is not null);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_check" CHECK (("reports"."target_type" = 'publication' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is null)
        or ("reports"."target_type" = 'publication_item' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is not null and "reports"."item_key" is not null)
        or ("reports"."target_type" = 'senior_note' and "reports"."senior_note_id" is not null and "reports"."note_version" is not null)
        or ("reports"."target_type" = 'case_study' and "reports"."case_study_id" is not null and "reports"."case_study_version" is not null)
        or ("reports"."target_type" = 'profile' and "reports"."profile_user_id" is not null)
        or ("reports"."target_type"::text = 'community_space' and "reports"."community_space_id" is not null)
        or ("reports"."target_type"::text = 'community_post' and "reports"."community_post_id" is not null)
        or ("reports"."target_type"::text = 'community_comment' and "reports"."community_comment_id" is not null)
        or ("reports"."target_type"::text = 'community_recruitment' and "reports"."community_recruitment_id" is not null)
        or ("reports"."target_type"::text = 'community_application' and "reports"."community_application_id" is not null));