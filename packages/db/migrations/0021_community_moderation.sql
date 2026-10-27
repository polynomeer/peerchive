CREATE TYPE "public"."community_sanction_level" AS ENUM('warning', 'write_suspended', 'permanent');--> statement-breakpoint
CREATE TYPE "public"."community_sanction_scope" AS ENUM('community', 'space');--> statement-breakpoint
CREATE TYPE "public"."sanction_request_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'community_report_filed';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'community_auto_hidden';--> statement-breakpoint
ALTER TYPE "public"."analytics_event_name" ADD VALUE 'community_sanction_issued';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'item_auto_hidden';--> statement-breakpoint
ALTER TYPE "public"."community_notice_kind" ADD VALUE 'item_restored';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'space_hide';--> statement-breakpoint
ALTER TYPE "public"."moderation_action_kind" ADD VALUE 'sanction';--> statement-breakpoint
CREATE TABLE "community_author_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"author_id" uuid,
	"reason" text NOT NULL,
	"report_id" uuid,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_author_lookups_target_check" CHECK (("community_author_lookups"."target_type" = 'post' and "community_author_lookups"."post_id" is not null and "community_author_lookups"."comment_id" is null) or ("community_author_lookups"."target_type" = 'comment' and "community_author_lookups"."comment_id" is not null and "community_author_lookups"."post_id" is null)),
	CONSTRAINT "community_author_lookups_reason_check" CHECK (char_length("community_author_lookups"."reason") between 1 and 1000),
	CONSTRAINT "community_author_lookups_basis_check" CHECK ("community_author_lookups"."report_id" is null or "community_author_lookups"."request_id" is null)
);
--> statement-breakpoint
CREATE TABLE "community_sanction_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"target_key" text NOT NULL,
	"reason" "report_reason" NOT NULL,
	"details" text,
	"status" "sanction_request_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"close_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_sanction_requests_target_check" CHECK (("community_sanction_requests"."post_id" is null) <> ("community_sanction_requests"."comment_id" is null)),
	CONSTRAINT "community_sanction_requests_details_check" CHECK ("community_sanction_requests"."details" is null or char_length("community_sanction_requests"."details") between 1 and 1000),
	CONSTRAINT "community_sanction_requests_close_note_check" CHECK ("community_sanction_requests"."close_note" is null or char_length("community_sanction_requests"."close_note") between 1 and 1000),
	CONSTRAINT "community_sanction_requests_closed_check" CHECK (("community_sanction_requests"."status" = 'open') = ("community_sanction_requests"."closed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "community_sanctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "community_sanction_scope" NOT NULL,
	"space_id" uuid,
	"level" "community_sanction_level" NOT NULL,
	"until" timestamp with time zone,
	"action_id" uuid NOT NULL,
	"lookup_id" uuid NOT NULL,
	"report_id" uuid,
	"request_id" uuid,
	"issued_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "community_sanctions_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "community_sanctions_scope_check" CHECK (("community_sanctions"."scope" = 'space') = ("community_sanctions"."space_id" is not null)),
	CONSTRAINT "community_sanctions_level_check" CHECK (("community_sanctions"."level" = 'write_suspended' and "community_sanctions"."until" is not null) or ("community_sanctions"."level" <> 'write_suspended' and "community_sanctions"."until" is null)),
	CONSTRAINT "community_sanctions_permanent_check" CHECK ("community_sanctions"."level" <> 'permanent' or "community_sanctions"."scope" = 'community'),
	CONSTRAINT "community_sanctions_revoked_check" CHECK (("community_sanctions"."revoked_at" is null) = ("community_sanctions"."revoked_by" is null))
);
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_reversed_check";--> statement-breakpoint
DROP INDEX "community_notices_post_unread_key";--> statement-breakpoint
ALTER TABLE "community_author_lookups" ADD CONSTRAINT "community_author_lookups_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_author_lookups" ADD CONSTRAINT "community_author_lookups_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_author_lookups" ADD CONSTRAINT "community_author_lookups_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_author_lookups" ADD CONSTRAINT "community_author_lookups_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_author_lookups" ADD CONSTRAINT "community_author_lookups_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_author_lookups" ADD CONSTRAINT "community_author_lookups_request_id_community_sanction_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."community_sanction_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanction_requests" ADD CONSTRAINT "community_sanction_requests_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanction_requests" ADD CONSTRAINT "community_sanction_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanction_requests" ADD CONSTRAINT "community_sanction_requests_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanction_requests" ADD CONSTRAINT "community_sanction_requests_comment_id_community_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."community_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanction_requests" ADD CONSTRAINT "community_sanction_requests_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_space_id_community_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."community_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_action_id_moderation_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_lookup_id_community_author_lookups_id_fk" FOREIGN KEY ("lookup_id") REFERENCES "public"."community_author_lookups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_request_id_community_sanction_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."community_sanction_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_author_lookups_created_idx" ON "community_author_lookups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "community_author_lookups_operator_idx" ON "community_author_lookups" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "community_author_lookups_post_idx" ON "community_author_lookups" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "community_author_lookups_comment_idx" ON "community_author_lookups" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "community_author_lookups_author_idx" ON "community_author_lookups" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_sanction_requests_open_key" ON "community_sanction_requests" USING btree ("requested_by","target_key") WHERE "community_sanction_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "community_sanction_requests_space_idx" ON "community_sanction_requests" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "community_sanction_requests_status_idx" ON "community_sanction_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "community_sanctions_user_idx" ON "community_sanctions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "community_sanctions_space_idx" ON "community_sanctions" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "community_sanctions_request_idx" ON "community_sanctions" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_notices_post_unread_key" ON "community_notices" USING btree ("post_id","user_id","kind") WHERE "community_notices"."post_id" is not null and "community_notices"."read_at" is null;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_community_item_check" CHECK ("moderation_actions"."kind"::text not in ('space_hide', 'sanction') or (("moderation_actions"."community_post_id" is null) <> ("moderation_actions"."community_comment_id" is null) and "moderation_actions"."community_space_id" is null));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_reversed_check" CHECK (("moderation_actions"."reversed_at" is null) = ("moderation_actions"."reverse_cause" is null) and ("moderation_actions"."reverse_cause" is null or "moderation_actions"."reverse_cause" in ('lift', 'appeal', 'space')) and ("moderation_actions"."reversed_at" is null or "moderation_actions"."kind" <> 'none'));