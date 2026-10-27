CREATE TYPE "public"."board_kind" AS ENUM('free', 'freshmen', 'alumni', 'question', 'info', 'recruiting', 'notice', 'general');--> statement-breakpoint
CREATE TYPE "public"."board_write_role" AS ENUM('member', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."community_name_mode" AS ENUM('real', 'display', 'anonymous');--> statement-breakpoint
CREATE TYPE "public"."community_space_kind" AS ENUM('official_school', 'official_department', 'user_room', 'study_room');--> statement-breakpoint
CREATE TYPE "public"."official_request_source" AS ENUM('student', 'student_council');--> statement-breakpoint
CREATE TYPE "public"."space_discovery" AS ENUM('listed', 'unlisted');--> statement-breakpoint
CREATE TYPE "public"."space_join_policy" AS ENUM('open', 'approval', 'invite');--> statement-breakpoint
CREATE TYPE "public"."space_membership_status" AS ENUM('pending', 'active', 'left', 'removed');--> statement-breakpoint
CREATE TYPE "public"."space_role" AS ENUM('owner', 'admin', 'moderator', 'member');--> statement-breakpoint
CREATE TYPE "public"."space_status" AS ENUM('active', 'archived', 'restricted');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'space_created';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'space_joined';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'restrict_space';--> statement-breakpoint
ALTER TYPE "public"."report_target_type" ADD VALUE 'community_space';--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" "board_kind" NOT NULL,
	"title" text NOT NULL,
	"write_role" "board_write_role" DEFAULT 'member' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boards_title_check" CHECK (char_length("boards"."title") between 1 and 30),
	CONSTRAINT "boards_notice_write_role_check" CHECK ("boards"."kind" <> 'notice' or "boards"."write_role" = 'moderator')
);
--> statement-breakpoint
CREATE TABLE "community_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "community_space_kind" NOT NULL,
	"school_id" uuid,
	"department_label" text,
	"department_key" text,
	"linked_course_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"slug" text NOT NULL,
	"current_name_mode" "community_name_mode" NOT NULL,
	"discovery" "space_discovery" DEFAULT 'listed' NOT NULL,
	"join_policy" "space_join_policy" DEFAULT 'open' NOT NULL,
	"capacity" integer DEFAULT 300 NOT NULL,
	"capacity_requested" integer,
	"status" "space_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"restricted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_spaces_slug_check" CHECK ("community_spaces"."slug" ~ '^[a-z0-9]{10}$'),
	CONSTRAINT "community_spaces_name_check" CHECK (char_length("community_spaces"."name") between 1 and 60),
	CONSTRAINT "community_spaces_description_check" CHECK ("community_spaces"."description" is null or char_length("community_spaces"."description") between 1 and 300),
	CONSTRAINT "community_spaces_capacity_check" CHECK ("community_spaces"."capacity" between 2 and 100000),
	CONSTRAINT "community_spaces_capacity_requested_check" CHECK ("community_spaces"."capacity_requested" is null or "community_spaces"."capacity_requested" between 2 and 100000),
	CONSTRAINT "community_spaces_official_check" CHECK ("community_spaces"."kind" not in ('official_school', 'official_department') or ("community_spaces"."school_id" is not null and "community_spaces"."current_name_mode" = 'anonymous')),
	CONSTRAINT "community_spaces_department_check" CHECK (("community_spaces"."kind" = 'official_department') = ("community_spaces"."department_key" is not null) and ("community_spaces"."department_key" is null) = ("community_spaces"."department_label" is null)),
	CONSTRAINT "community_spaces_department_label_check" CHECK ("community_spaces"."department_label" is null or char_length("community_spaces"."department_label") between 1 and 40),
	CONSTRAINT "community_spaces_archived_check" CHECK ("community_spaces"."status" <> 'archived' or "community_spaces"."archived_at" is not null),
	CONSTRAINT "community_spaces_restricted_check" CHECK ("community_spaces"."status" <> 'restricted' or "community_spaces"."restricted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "official_page_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"department_label" text,
	"department_key" text DEFAULT '' NOT NULL,
	"requester_id" uuid NOT NULL,
	"source" "official_request_source" DEFAULT 'student' NOT NULL,
	"source_marked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_page_requests_department_check" CHECK (("official_page_requests"."department_key" = '') = ("official_page_requests"."department_label" is null)),
	CONSTRAINT "official_page_requests_department_label_check" CHECK ("official_page_requests"."department_label" is null or char_length("official_page_requests"."department_label") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "space_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_invitations_token_hash_check" CHECK ("space_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "space_invitations_used_check" CHECK (("space_invitations"."used_at" is null) = ("space_invitations"."used_by" is null))
);
--> statement-breakpoint
CREATE TABLE "space_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "space_role" DEFAULT 'member' NOT NULL,
	"status" "space_membership_status" NOT NULL,
	"joined_at" timestamp with time zone,
	"requested_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_memberships_active_joined_check" CHECK ("space_memberships"."status" <> 'active' or "space_memberships"."joined_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "community_space_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "community_space_id" uuid;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_linked_course_id_courses_id_fk" FOREIGN KEY ("linked_course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_spaces" ADD CONSTRAINT "community_spaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_page_requests" ADD CONSTRAINT "official_page_requests_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_page_requests" ADD CONSTRAINT "official_page_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_page_requests" ADD CONSTRAINT "official_page_requests_source_marked_by_users_id_fk" FOREIGN KEY ("source_marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boards_space_title_key" ON "boards" USING btree ("space_id","title");--> statement-breakpoint
CREATE INDEX "boards_space_position_idx" ON "boards" USING btree ("space_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "community_spaces_slug_key" ON "community_spaces" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "community_spaces_official_school_key" ON "community_spaces" USING btree ("school_id") WHERE "community_spaces"."kind" = 'official_school';--> statement-breakpoint
CREATE UNIQUE INDEX "community_spaces_official_department_key" ON "community_spaces" USING btree ("school_id","department_key") WHERE "community_spaces"."kind" = 'official_department';--> statement-breakpoint
CREATE INDEX "community_spaces_school_id_idx" ON "community_spaces" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "community_spaces_status_discovery_idx" ON "community_spaces" USING btree ("status","discovery");--> statement-breakpoint
CREATE UNIQUE INDEX "official_page_requests_target_requester_key" ON "official_page_requests" USING btree ("school_id","department_key","requester_id");--> statement-breakpoint
CREATE INDEX "official_page_requests_target_idx" ON "official_page_requests" USING btree ("school_id","department_key");--> statement-breakpoint
CREATE INDEX "official_page_requests_requester_idx" ON "official_page_requests" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "space_invitations_token_hash_key" ON "space_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "space_invitations_space_id_idx" ON "space_invitations" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "space_memberships_space_user_key" ON "space_memberships" USING btree ("space_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "space_memberships_active_owner_key" ON "space_memberships" USING btree ("space_id") WHERE "space_memberships"."role" = 'owner' and "space_memberships"."status" = 'active';--> statement-breakpoint
CREATE INDEX "space_memberships_user_id_idx" ON "space_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "space_memberships_space_status_idx" ON "space_memberships" USING btree ("space_id","status");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_community_space_id_community_spaces_id_fk" FOREIGN KEY ("community_space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_community_space_id_community_spaces_id_fk" FOREIGN KEY ("community_space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_community_space_idx" ON "moderation_actions" USING btree ("community_space_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_space_check" CHECK ("moderation_actions"."kind"::text <> 'restrict_space' or "moderation_actions"."community_space_id" is not null);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_check" CHECK (("reports"."target_type" = 'publication' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is null)
        or ("reports"."target_type" = 'publication_item' and "reports"."publication_id" is not null and "reports"."release_id" is not null and "reports"."item_kind" is not null and "reports"."item_key" is not null)
        or ("reports"."target_type" = 'senior_note' and "reports"."senior_note_id" is not null and "reports"."note_version" is not null)
        or ("reports"."target_type" = 'case_study' and "reports"."case_study_id" is not null and "reports"."case_study_version" is not null)
        or ("reports"."target_type" = 'profile' and "reports"."profile_user_id" is not null)
        or ("reports"."target_type"::text = 'community_space' and "reports"."community_space_id" is not null));